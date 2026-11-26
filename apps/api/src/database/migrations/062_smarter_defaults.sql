-- Devices Nigafiy approves by itself, so people are not asked about what is obviously theirs
-- (owner decision 2026-11-26). trust_reason says why a device is "known" without a person:
--   first_scan     — it was already on the network at the first scan of its range (the baseline);
--   this_computer  — the computer the Sensor runs on (the Sensor reports its own interfaces);
--   gateway        — the default gateway the Sensor routes through;
--   same_name      — it came back under a new MAC (a new private address, another network card) and
--                    announces the same specific name as a known device that was not seen at that time.
-- NULL means a person set the trust (or nobody did yet). Any change made by a person clears it.
ALTER TABLE devices
  ADD COLUMN trust_reason text CHECK (trust_reason IS NULL OR trust_reason IN ('first_scan', 'this_computer', 'gateway', 'same_name'));

-- Existing networks: what was there at the first applied sweep of the site becomes known, as on a
-- new install. Devices that joined later stay "not reviewed".
UPDATE devices d
   SET trust = 'known', trust_reason = 'first_scan', trust_changed_at = now()
 WHERE d.trust = 'unreviewed'
   AND d.first_seen_at <= (SELECT min(r.finished_at) FROM discovery_runs r WHERE r.site_id = d.site_id AND r.applied);

-- Knowledge suggestions: the same problem captured again and again (same title and rules) left dozens
-- of identical suggestions to review. Keep the newest untouched one of each; edited ones are never removed.
DELETE FROM knowledge_entries k
 WHERE k.status = 'candidate' AND k.source = 'incident' AND NOT k.edited
   AND EXISTS (SELECT 1 FROM knowledge_entries n
                WHERE n.organization_id = k.organization_id AND n.status = 'candidate' AND n.title = k.title
                  AND n.rule_ids = k.rule_ids AND (n.created_at, n.id) > (k.created_at, k.id));
