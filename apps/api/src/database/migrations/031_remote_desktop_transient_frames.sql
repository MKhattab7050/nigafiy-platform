-- Remote desktop frames are transient (modules/endpoints/remote-desktop/frames.ts): the JPEG goes
-- from the agent's upload to the waiting technician through memory and pg_notify, never a table.
--   * endpoint_commands.result_data of rd_capture keeps only the frame's metadata: strip the images
--     earlier versions stored there;
--   * endpoints.last_rd_frame (the latest frame of every endpoint) is dropped.
-- The session's start and stop stay in audit_logs and network_events, unchanged.

UPDATE endpoint_commands
   SET result_data = result_data - 'jpeg_base64'
 WHERE kind = 'rd_capture' AND result_data ? 'jpeg_base64';

ALTER TABLE endpoints DROP COLUMN IF EXISTS last_rd_frame;
