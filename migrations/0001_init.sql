CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  participant INTEGER NOT NULL DEFAULT 0 CHECK(participant IN (0,1))
);
CREATE TABLE IF NOT EXISTS bookings (
  day TEXT NOT NULL,
  place INTEGER NOT NULL CHECK(place IN (1,2)),
  slot INTEGER NOT NULL CHECK(slot IN (0,1)),
  user_id INTEGER NOT NULL,
  PRIMARY KEY(day, place, slot)
);
CREATE TABLE IF NOT EXISTS states (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('add','remove')),
  expires INTEGER NOT NULL
);
-- Mutation receipts prevent a retried Telegram update from changing data twice.
CREATE TABLE IF NOT EXISTS receipts (
  update_id INTEGER PRIMARY KEY,
  created INTEGER NOT NULL
);
