-- PASH Gateway v2 — Initial Database Schema
-- FIX (audit): Database schema was completely missing from original plan.
-- PostgreSQL 14+

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- Organizations (Multi-tenancy)
-- FIX: org_id isolation for all data — prevents tenant data leakage
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  line_limit  INTEGER NOT NULL DEFAULT 300000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_organizations_plan ON organizations (plan);

-- ─────────────────────────────────────────────────────────────────────────────
-- API Keys
-- FIX (audit #2): Keys stored as SHA-256 hashes, NEVER plaintext.
-- FIX: Keys have environment (live/test) and status for revocation.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the raw key
  key_prefix  TEXT NOT NULL,          -- first 8 chars for identification (e.g. pash_liv)
  env         TEXT NOT NULL DEFAULT 'live'
                CHECK (env IN ('live', 'test')),
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked', 'expired')),
  name        TEXT,                   -- human label ("Production Key")
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash   ON api_keys (key_hash);
CREATE INDEX idx_api_keys_org_id ON api_keys (org_id);
CREATE INDEX idx_api_keys_status ON api_keys (status);

-- Denormalized plan/limit onto api_keys for fast auth without JOIN
ALTER TABLE api_keys
  ADD COLUMN plan        TEXT    NOT NULL DEFAULT 'free',
  ADD COLUMN line_limit  INTEGER NOT NULL DEFAULT 300000;

-- ─────────────────────────────────────────────────────────────────────────────
-- Component Schemas
-- Versioned schema registry — supports v1, v2, v3 per component
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE component_schemas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organizations (id) ON DELETE CASCADE,  -- NULL = global
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  schema_json  JSONB NOT NULL,
  deprecated   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name, version)
);

CREATE INDEX idx_schemas_name    ON component_schemas (name);
CREATE INDEX idx_schemas_org     ON component_schemas (org_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sessions
-- Lightweight session metadata — full tree state is in Redis
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations (id),
  api_key_id      UUID REFERENCES api_keys (id),
  snapshot_hash   TEXT,
  snapshot_ts     TIMESTAMPTZ,
  tree_size       INTEGER NOT NULL DEFAULT 0,
  lines_generated INTEGER NOT NULL DEFAULT 0,
  tokens_saved    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  edge_node       TEXT    -- which edge node owns this session
);

CREATE INDEX idx_sessions_org_id     ON sessions (org_id);
CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Billing Events
-- FIX (audit #10): Real token counts + auditable methodology
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE billing_events (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES organizations (id),
  session_id                UUID REFERENCES sessions (id),
  pash_lines                INTEGER NOT NULL DEFAULT 0,
  actual_pash_tokens        INTEGER NOT NULL DEFAULT 0,
  estimated_baseline_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_saved              INTEGER NOT NULL DEFAULT 0,
  cost_saved_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
  baseline_format           TEXT NOT NULL DEFAULT 'json'
                              CHECK (baseline_format IN ('json', 'html')),
  methodology               TEXT NOT NULL DEFAULT 'PASH_BENCHMARK_V1',
  provider                  TEXT,
  model                     TEXT,
  is_byok                   BOOLEAN NOT NULL DEFAULT FALSE,
  ts                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_org_id ON billing_events (org_id, ts DESC);
CREATE INDEX idx_billing_ts     ON billing_events (ts DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Deterministic Templates
-- For the Deterministic Path (no LLM call needed)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE deterministic_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES organizations (id),  -- NULL = global
  name            TEXT NOT NULL,
  input_schema    JSONB NOT NULL,   -- JSON Schema for input matching
  pash_template   TEXT NOT NULL,    -- PASH v2 output template (with {{placeholders}})
  match_strategy  TEXT NOT NULL DEFAULT 'exact'
                    CHECK (match_strategy IN ('exact', 'semantic', 'schema')),
  usage_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_templates_org  ON deterministic_templates (org_id);
CREATE INDEX idx_templates_name ON deterministic_templates (name);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit Log
-- Security: record key operations for compliance
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID REFERENCES organizations (id),
  actor_key   TEXT,   -- key_prefix, NOT hash or raw key
  action      TEXT NOT NULL,   -- 'key.create', 'key.revoke', 'plan.change', etc.
  target_id   TEXT,
  meta        JSONB,
  ip_address  INET,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_org_ts ON audit_log (org_id, ts DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON deterministic_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: default free plan limits
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE organizations     IS 'Multi-tenant organizations';
COMMENT ON TABLE api_keys          IS 'API keys stored as SHA-256 hashes — never plaintext';
COMMENT ON TABLE billing_events    IS 'Auditable token savings per generation event';
COMMENT ON TABLE component_schemas IS 'Versioned component schema registry';
