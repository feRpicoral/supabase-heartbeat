INSERT INTO heartbeat.pings (id, touched_at)
VALUES ($1, NOW())
ON CONFLICT (id)
DO UPDATE SET touched_at = EXCLUDED.touched_at;

