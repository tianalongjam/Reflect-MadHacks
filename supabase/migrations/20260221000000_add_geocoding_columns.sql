ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_facilities_needs_geocoding
  ON public.facilities (geocoded_at) WHERE geocoded_at IS NULL;
