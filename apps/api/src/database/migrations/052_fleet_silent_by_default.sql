-- Owner decision 2026-11-26 ("everything silent"): sessions on company-managed computers do not
-- interrupt the person. Unattended groups that exist already take banner_mode = 'off'; new groups
-- are unattended with the banner off unless an admin picks otherwise (fleet-policy/schema.ts), and
-- computers in no group follow the same rule (fleet-policy/policy.ts). Attended groups, help
-- requests, Quick Support and phones still show the full banner (the person is asked). The audit
-- log is written in every mode.
UPDATE fleet_groups SET banner_mode = 'off' WHERE access_mode = 'unattended' AND banner_mode = 'shown';
