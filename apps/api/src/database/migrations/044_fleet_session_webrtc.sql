-- Fleet Pro: WebRTC video for remote desktop (docs/features/fleet-pro.md "WebRTC video").
--
-- The picture can now reach an operator's browser as H.264 over a direct WebRTC peer connection on
-- the LAN (signalled over the existing stream sockets), with the WebSocket + JPEG path as the
-- automatic fallback. fleet_sessions records which transport carried the picture:
--
--  * transport            'webrtc' once a viewer decoded the first WebRTC video frame (it stays
--                         'webrtc' for the session's history even if a viewer later fell back).
--  * rtc_encoder          the agent's H.264 encoder (Media Foundation hardware or software MFT).
--  * rtc_started_at       when the first WebRTC viewer started.
--  * rtc_fallback_reason  the last reason a viewer went back to JPEG (no answer, ICE failed,
--                         encoder failed, recording switched on, …). Never an address or SDP.
--
-- The offers, answers and ICE candidates themselves are never stored.

ALTER TABLE fleet_sessions DROP CONSTRAINT fleet_sessions_transport_check;
ALTER TABLE fleet_sessions ADD CONSTRAINT fleet_sessions_transport_check CHECK (transport IN ('http', 'ws', 'webrtc'));
ALTER TABLE fleet_sessions
  ADD COLUMN rtc_encoder         text,
  ADD COLUMN rtc_started_at      timestamptz,
  ADD COLUMN rtc_fallback_reason text;
