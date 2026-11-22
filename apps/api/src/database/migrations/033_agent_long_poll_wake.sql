-- Agent long-poll (Fleet Pro): an agent's POST /api/v1/agent/poll?wait_ms= waits until a command
-- is queued for it instead of asking every 500 ms. Every new pending command wakes the waiting
-- request on whichever API instance holds it: this trigger sends pg_notify('ld_agent_wake',
-- <endpoint id>), which PostgreSQL delivers on COMMIT to every listening API instance. The
-- notification carries only the endpoint id; nothing else is stored.

CREATE OR REPLACE FUNCTION endpoint_commands_wake_agent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('ld_agent_wake', NEW.endpoint_id::text);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS endpoint_commands_wake_agent ON endpoint_commands;
CREATE TRIGGER endpoint_commands_wake_agent
  AFTER INSERT ON endpoint_commands
  FOR EACH ROW EXECUTE FUNCTION endpoint_commands_wake_agent();
