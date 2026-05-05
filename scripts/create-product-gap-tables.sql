-- Run this ONCE in the BigQuery console (project `yhangry`) to set up
-- the dispute agent's product gap tracking tables.
--
-- Prerequisites:
-- 1. Service account `akifa-agent@yhangry.iam.gserviceaccount.com` must have
--    `BigQuery Data Editor` granted on the `dispute_agent` dataset (or the
--    project, but dataset-scoped is preferred). Ask Jordan.
-- 2. After running this script, set on Render env:
--      PRODUCT_GAPS_ENABLED=true
--      PRODUCT_GAPS_DATASET=dispute_agent  (default — only set if changed)
--      SLACK_PRODUCT_GAPS_CHANNEL_ID=C0B16DYFTQA
--
-- Region note: pick the location that matches `yhangry_booking`. yhangry's
-- production data is in EU. If yhangry_booking is in a different region,
-- change the OPTIONS clause below to match — BigQuery cross-region queries
-- between datasets fail.

CREATE SCHEMA IF NOT EXISTS `yhangry.dispute_agent`
OPTIONS (location = 'EU');

-- One row per (dispute_id, tag) pair emitted by Gemini.
-- Denormalized so the threshold check can run without joining back to
-- production booking tables.
CREATE TABLE IF NOT EXISTS `yhangry.dispute_agent.product_gap_events` (
  dispute_id           STRING    NOT NULL,
  booking_id           INT64,
  tag                  STRING    NOT NULL,
  network_reason_code  STRING,
  event_date           DATE,
  inserted_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(inserted_at)
CLUSTER BY tag, dispute_id;

-- One row per Slack alert posted to #product-gaps. Used to suppress
-- re-alerting on the same tag within a 14-day window.
CREATE TABLE IF NOT EXISTS `yhangry.dispute_agent.product_gap_alerts` (
  tag               STRING    NOT NULL,
  occurrence_count  INT64     NOT NULL,
  alerted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY tag;
