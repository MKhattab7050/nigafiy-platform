-- Device identification: what each device says about itself (mDNS, SSDP/UPnP, NetBIOS) and the
-- classification derived from it.

ALTER TABLE devices
  -- Raw, device-supplied clues: { names: [{source,name}], services: [], hints: {}, ssdp: {} }.
  ADD COLUMN fingerprint     jsonb NOT NULL DEFAULT '{}',
  -- How sure the classification rule is. NULL for manual or unclassified devices.
  ADD COLUMN type_confidence text CHECK (type_confidence IN ('high', 'medium', 'low')),
  -- Where `hostname` came from: rdns | mdns | netbios | ssdp.
  ADD COLUMN name_source     text;

UPDATE devices SET name_source = 'rdns' WHERE hostname IS NOT NULL;
UPDATE devices SET type_confidence = 'medium' WHERE type_source = 'inferred';
