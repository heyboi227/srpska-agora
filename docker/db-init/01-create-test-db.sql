-- Runs once, when the data volume is first initialised. Creates the database
-- used by the PostgreSQL integration tests so they never touch development data.
CREATE DATABASE srpska_agora_test OWNER agora;
