/**
 * Fail-closed audit: live DB must match lib/drafting/schema-contract.ts.
 * Usage: npm run verify:drafting
 */
import fs from 'node:fs';
import path from 'node:path';

import { Pool } from 'pg';

import {
  DRAFTING_REQUIRED_COLUMNS,
  DRAFTING_REQUIRED_FUNCTIONS,
  DRAFTING_REQUIRED_TABLES,
  formatDraftingSchemaDrift,
} from '../lib/drafting/schema-contract';

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

export type DraftingSchemaVerifyResult = {
  ok: boolean;
  missing: string[];
};

function parseQualifiedName(qualified: string): { schema: string; name: string } {
  const [schema, name] = qualified.split('.');
  if (!schema || !name) {
    throw new Error(`Invalid qualified name: ${qualified}`);
  }
  return { schema, name };
}

export async function verifyDraftingSchema(pool: Pool): Promise<DraftingSchemaVerifyResult> {
  const missing: string[] = [];

  for (const qualifiedTable of DRAFTING_REQUIRED_TABLES) {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS exists`,
      [qualifiedTable],
    );
    if (!result.rows[0]?.exists) {
      missing.push(`table ${qualifiedTable}`);
    }
  }

  for (const requirement of DRAFTING_REQUIRED_COLUMNS) {
    const { schema, name } = parseQualifiedName(requirement.table);
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
            AND column_name = $3
       ) AS exists`,
      [schema, name, requirement.column],
    );
    if (!result.rows[0]?.exists) {
      missing.push(`column ${requirement.table}.${requirement.column} (${requirement.reason})`);
    }
  }

  for (const requirement of DRAFTING_REQUIRED_FUNCTIONS) {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_proc AS p
           JOIN pg_namespace AS n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
            AND p.proname = $2
       ) AS exists`,
      [requirement.schema, requirement.name],
    );
    if (!result.rows[0]?.exists) {
      missing.push(`function ${requirement.schema}.${requirement.name} (${requirement.reason})`);
    }
  }

  return { ok: missing.length === 0, missing };
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DIRECT_DATABASE_URL is not set (check .env.local)');
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.platform === 'win32' ? false : { rejectUnauthorized: false },
    max: 2,
  });

  try {
    const result = await verifyDraftingSchema(pool);
    if (!result.ok) {
      console.error(formatDraftingSchemaDrift(result.missing));
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      tables: DRAFTING_REQUIRED_TABLES.length,
      columns: DRAFTING_REQUIRED_COLUMNS.length,
      functions: DRAFTING_REQUIRED_FUNCTIONS.length,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[verify_drafting_schema]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
