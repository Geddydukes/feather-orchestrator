CREATE TABLE IF NOT EXISTS agent_memory_turns (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content JSONB NOT NULL,
    tokens INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_memory_turns_session_created_at_idx
    ON agent_memory_turns (session_id, created_at);

CREATE INDEX IF NOT EXISTS agent_memory_turns_session_id_idx
    ON agent_memory_turns (session_id);
