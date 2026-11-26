-- Whose device it is, worked out from the name the device announces ("Saras-iPhone" -> Sara), so
-- people do not have to type it. owner_source says where the owner came from:
--   name   — guessed from the device's own announced name (shown as a guess, never as fact);
--   manual — a person set or cleared it; a guess never replaces that again.
-- NULL means nobody set it and nothing was guessed yet.
ALTER TABLE devices
  ADD COLUMN owner_source text CHECK (owner_source IS NULL OR owner_source IN ('name', 'manual'));

-- Owners already filled in were typed by people.
UPDATE devices SET owner_source = 'manual' WHERE owner IS NOT NULL;
