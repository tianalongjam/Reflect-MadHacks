import express from 'express';
import multer from 'multer';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(express.json());
app.use(cookieParser()); app.use(cors({ origin: 'http://localhost:5174', credentials: true }));

// Identity middleware: read or create uid cookie, upsert user row
app.use(async (req, res, next) => {
  let uid = req.cookies.uid;
  if (!uid) {
    uid = uuidv4();
    res.cookie('uid', uid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
    try {
      await supabase.from('users').insert({ id: uid });
    } catch {
      // Supabase may be unavailable; cookie identity still works
    }
  }
  req.userId = uid;
  next();
});

// Get current user
app.get('/api/me', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, created_at')
      .eq('id', req.userId)
      .single();
    if (error) throw error;
    res.json(data);
  } catch {
    // Supabase may be unavailable; return minimal identity from cookie
    res.json({ id: req.userId, name: null, created_at: null });
  }
});

// Update current user's name
app.post('/api/me', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ name: name.trim(), updated_at: new Date().toISOString() })
      .eq('id', req.userId)
      .select('id, name, created_at')
      .single();
    if (error) throw error;
    res.json(data);
  } catch {
    // Supabase may be unavailable; echo back the name so the UI can proceed
    res.json({ id: req.userId, name: name.trim(), created_at: null });
  }
});

// ── Her original routes (unchanged) ──────────────────────────────────────────

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded.' });
  }
  const filePath = req.file.path;
  try {
    const base64Image = fs.readFileSync(filePath).toString('base64');
    const mimeType = req.file.mimetype;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe all the handwritten text in this image exactly as written. Return only the transcribed text, nothing else.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
    });
    const text = response.choices[0].message.content;
    const { data, error: dbError } = await supabase
      .from('entries')
      .insert({ text, user_id: req.userId })
      .select()
      .single();
    if (dbError) throw new Error(dbError.message);
    res.json({ text, id: data.id, created_at: data.created_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'OpenAI request failed.' });
  } finally {
    fs.unlinkSync(filePath);
  }
});

app.get('/api/entries', async (req, res) => {
  const { data, error } = await supabase
    .from('entries')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export { app };

// ── New: Distance endpoint ────────────────────────────────────────────────────
// GET /api/distance?origin=53703&destination=219+Dothan+Rd+Abbeville+AL+36310
//
// Returns:
//   driving_distance  — e.g. "12.4 mi"
//   driving_duration  — e.g. "18 mins"
//   straight_miles    — e.g. 9.8  (number)

app.get('/api/distance', async (req, res) => {
  const { origin, destination } = req.query;

  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination are required' });
  }

  const key = process.env.GOOGLE_MAPS_KEY;

  try {
    // ── 1. Driving distance via Distance Matrix API ───────────────────────────
    const matrixURL = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    matrixURL.searchParams.set('origins', origin);
    matrixURL.searchParams.set('destinations', destination);
    matrixURL.searchParams.set('units', 'imperial');
    matrixURL.searchParams.set('key', key);

    const matrixRes = await fetch(matrixURL.toString());
    const matrixData = await matrixRes.json();

    const element = matrixData.rows?.[0]?.elements?.[0];
    const status = element?.status;

    let driving_distance = null;
    let driving_duration = null;

    if (status === 'OK') {
      driving_distance = element.distance.text;  // e.g. "12.4 mi"
      driving_duration = element.duration.text;  // e.g. "18 mins"
    }

    // ── 2. Straight-line distance via Geocoding API ───────────────────────────
    async function geocode(address) {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('address', address);
      url.searchParams.set('key', key);
      const r = await fetch(url.toString());
      const d = await r.json();
      const loc = d.results?.[0]?.geometry?.location;
      return loc ? { lat: loc.lat, lng: loc.lng } : null;
    }

    function haversine(lat1, lng1, lat2, lng2) {
      const R = 3958.8; // Earth radius in miles
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    const [originCoords, destCoords] = await Promise.all([
      geocode(origin),
      geocode(destination),
    ]);

    let straight_miles = null;
    if (originCoords && destCoords) {
      straight_miles = Math.round(
        haversine(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng) * 10
      ) / 10;
    }

    res.json({ driving_distance, driving_duration, straight_miles, status });

  } catch (err) {
    console.error('Distance API error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
const isDirectRun = process.argv[1]?.includes('server');
if (isDirectRun) {
  app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
}
