/**
 * Allow Next.js dev to start when native @next/swc-* downloads fail (corp npm 503).
 * Re-apply after `npm ci` if dev crashes on SWC download.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'lib', 'download-swc.js');
const marker = 'Skipping native swc download for';
const source = fs.readFileSync(target, 'utf8');

if (source.includes(marker)) {
  console.log('next swc fallback patch already applied');
  process.exit(0);
}

const patched = source.replace(
  '        await extractBinary(outputDirectory, pkgName, tarFileName);\n    }\n}',
  `        try {
            await extractBinary(outputDirectory, pkgName, tarFileName);
        } catch (error) {
            _log.warn(\`Skipping native swc download for \${pkgName}: \${error instanceof Error ? error.message : error}\`);
        }
    }
}`,
);

if (patched === source) {
  console.error('Could not patch next download-swc.js — pattern not found');
  process.exit(1);
}

fs.writeFileSync(target, patched);
console.log('Applied next swc fallback patch');
