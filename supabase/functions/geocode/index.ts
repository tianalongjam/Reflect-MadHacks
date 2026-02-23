import { createClient } from "@supabase/supabase-js";
import { haversine } from "./haversine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function geocodeAddress(
  address: string,
): Promise<{ lat: number; lng: number }> {
  const apiKey = Deno.env.get("GOOGLE_GEOCODING_API_KEY");
  if (!apiKey) {
    throw new Error("GOOGLE_GEOCODING_API_KEY is not set");
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Google Geocoding API returned HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status === "REQUEST_DENIED") {
    throw new Error(`Google Geocoding API request denied: ${data.error_message ?? "unknown reason"}`);
  }

  if (data.status === "ZERO_RESULTS") {
    throw new Error("ZERO_RESULTS: no location found for the given address");
  }

  if (data.status !== "OK") {
    throw new Error(`Google Geocoding API status: ${data.status}`);
  }

  const location = data.results[0].geometry.location;
  return { lat: location.lat, lng: location.lng };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "facility") {
      const { facility_id, address } = body;
      if (!facility_id || !address) {
        return new Response(
          JSON.stringify({ error: "facility_id and address are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      // Check cache
      const { data: existing, error: fetchError } = await supabase
        .from("facilities")
        .select("lat, lng")
        .eq("facility_id", facility_id)
        .single();

      if (fetchError) {
        return new Response(
          JSON.stringify({ error: `Facility lookup failed: ${fetchError.message}` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (existing.lat != null && existing.lng != null) {
        return new Response(
          JSON.stringify({ lat: existing.lat, lng: existing.lng, cached: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Geocode and cache
      const coords = await geocodeAddress(address);

      const { error: updateError } = await supabase
        .from("facilities")
        .update({ lat: coords.lat, lng: coords.lng, geocoded_at: new Date().toISOString() })
        .eq("facility_id", facility_id);

      if (updateError) {
        return new Response(
          JSON.stringify({ error: `Failed to cache coordinates: ${updateError.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ lat: coords.lat, lng: coords.lng, cached: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "user") {
      const { query } = body;
      if (!query) {
        return new Response(
          JSON.stringify({ error: "query is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const coords = await geocodeAddress(query);

      return new Response(
        JSON.stringify({ lat: coords.lat, lng: coords.lng }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "nearest") {
      const { query, state, limit } = body;
      if (!query || !state) {
        return new Response(
          JSON.stringify({ error: "query and state are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const userCoords = await geocodeAddress(query);

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      let q = supabase
        .from("facilities")
        .select("*")
        .eq("state", state)
        .not("lat", "is", null)
        .not("lng", "is", null);

      // Apply boolean filters
      const booleanFilters = [
        "telehealth", "medicaid", "sliding_scale", "private_insurance",
        "trauma_care", "co_occurring", "serves_veterans", "serves_lgbtq",
        "serves_children", "serves_young_adults", "serves_seniors",
        "cbt", "dbt", "emdr",
      ];
      for (const key of booleanFilters) {
        if (body[key] === true) {
          q = q.eq(key, true);
        }
      }

      const { data: facilities, error: dbError } = await q;

      if (dbError) {
        return new Response(
          JSON.stringify({ error: `Database query failed: ${dbError.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const withDistance = (facilities || [])
        .map((f) => ({
          ...f,
          distance_miles: Math.round(
            haversine(userCoords.lat, userCoords.lng, f.lat, f.lng) * 10,
          ) / 10,
        }))
        .sort((a, b) => a.distance_miles - b.distance_miles)
        .slice(0, limit || 30);

      return new Response(
        JSON.stringify({ user_coords: userCoords, results: withDistance }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
