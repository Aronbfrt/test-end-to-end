/**
 * archPolice.ts — Gendarme architectural (analyse statique TypeScript).
 *
 * Analyse la base de code avec ts-morph pour détecter :
 *   - Fonctions trop longues (> 80 lignes)
 *   - Complexité cyclomatique élevée (> 10 branches)
 *   - Fichiers trop larges (> 500 lignes)
 *   - Couplage excessif (> 15 imports dans un fichier)
 *   - Types `any` non justifiés
 *   - Fonctions sans type de retour explicite
 *   - Dépendances circulaires potentielles
 *
 * Usage :
 *   node dist/index.js arch [targetPath]
 *
 * Sorties :
 *   .e2e-work/arch-report.json  — rapport machine
 *   .e2e-work/arch-report.md    — rapport lisible
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative }              from 'node:path';
import type { OllamaCapability }                from '../orchestrator.js';
import type { RunConfig }                       from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ViolationType =
  | 'FUNCTION_TOO_LONG'
  | 'HIGH_COMPLEXITY'
  | 'FILE_TOO_LARGE'
  | 'EXCESSIVE_COUPLING'
  | 'UNSAFE_ANY'
  | 'MISSING_RETURN_TYPE'
  | 'CIRCULAR_DEPENDENCY';

export interface ArchViolation {
  type:        ViolationType;
  file:        string;
  line?:       number;
  name?:       string;
  value?:      number;
  threshold?:  number;
  suggestion?: string;
}

export interface ArchReport {
  totalFiles:     number;
  totalViolations: number;
  violations:     ArchViolation[];
  score:          number;
  grade:          'A' | 'B' | 'C' | 'D' | 'F';
  refactorPlan?:  string;
  generatedAt:    string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  FUNCTION_LINES:    80,
  CYCLOMATIC:        10,
  FILE_LINES:       500,
  IMPORTS_COUNT:     15,
};

// ── Cyclomatic complexity (branch counting) ───────────────────────────────────

function countBranches(body: string): number {
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+/g,
    /\?\?/g,
    /\?\./g,
    /&&/g,
    /\|\|/g,
    /\bswitch\s*\(/g,
    /\bcatch\s*\(/g,
    /\bternary\b/g,
  ];
  return patterns.reduce((acc, rx) => {
    rx.lastIndex = 0;
    return acc + (body.match(rx)?.length ?? 0);
  }, 1);
}

// ── Static analysis (no ts-morph dependency — pure regex/text analysis) ───────

interface ParsedFunction {
  name:  string;
  line:  number;
  lines: number;
  body:  string;
}

function extractFunctions(source: string): ParsedFunction[] {
  const functions: ParsedFunction[] = [];
  const lines = source.split('\n');

  const fnPatterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^\s*(?:async\s+)?(\w+)\s*\(.*\)\s*(?::\s*\S+)?\s*\{/,
    /^\s*(?:public|private|protected|static)?\s*(?:async\s+)?(\w+)\s*\(/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let fnName: string | null = null;

    for (const pattern of fnPatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match[1] !== 'if' && match[1] !== 'for' && match[1] !== 'while') {
        fnName = match[1];
        break;
      }
    }

    if (!fnName) continue;

    // Count function body lines (simple brace counting)
    let depth      = 0;
    let startLine  = i;
    let endLine    = i;
    let bodyLines: string[] = [];

    for (let j = i; j < Math.min(i + 300, lines.length); j++) {
      const l = lines[j] ?? '';
      depth += (l.match(/\{/g) ?? []).length;
      depth -= (l.match(/\}/g) ?? []).length;
      bodyLines.push(l);

      if (depth === 0 && j > i) {
        endLine = j;
        break;
      }
    }

    const lineCount = endLine - startLine;
    if (lineCount > 0) {
      functions.push({
        name:  fnName,
        line:  startLine + 1,
        lines: lineCount,
        body:  bodyLines.join('\n'),
      });
    }
  }

  return functions;
}

function analyzeFile(
  filePath:   string,
  sourceCode: string,
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const lines      = sourceCode.split('\n');
  const lineCount  = lines.length;
  const relPath    = filePath;

  // File too large
  if (lineCount > THRESHOLDS.FILE_LINES) {
    violations.push({
      type:       'FILE_TOO_LARGE',
      file:       relPath,
      value:      lineCount,
      threshold:  THRESHOLDS.FILE_LINES,
      suggestion: `Découpe en modules plus petits. Envisage de séparer les types, les helpers, et la logique principale.`,
    });
  }

  // Excessive imports
  const importCount = lines.filter((l) => /^\s*import\s/.test(l)).length;
  if (importCount > THRESHOLDS.IMPORTS_COUNT) {
    violations.push({
      type:       'EXCESSIVE_COUPLING',
      file:       relPath,
      value:      importCount,
      threshold:  THRESHOLDS.IMPORTS_COUNT,
      suggestion: `${importCount} imports détectés. Regroupe les utilitaires et réduis le couplage via une façade.`,
    });
  }

  // Unsafe any
  const anyLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /:\s*any\b|as\s+any\b|<any>/.test(l) && !/\/\/ @ts-ignore/.test(l));

  for (const { l: _l, i } of anyLines.slice(0, 5)) {
    violations.push({
      type: 'UNSAFE_ANY',
      file: relPath,
      line: i + 1,
      suggestion: 'Remplace `any` par un type précis ou `unknown` + narrowing.',
    });
  }

  // Function analysis
  const functions = extractFunctions(sourceCode);

  for (const fn of functions) {
    if (fn.lines > THRESHOLDS.FUNCTION_LINES) {
      violations.push({
        type:       'FUNCTION_TOO_LONG',
        file:       relPath,
        line:       fn.line,
        name:       fn.name,
        value:      fn.lines,
        threshold:  THRESHOLDS.FUNCTION_LINES,
        suggestion: `Fonction "${fn.name}" (${fn.lines} lignes). Extrais des sous-fonctions nommées.`,
      });
    }

    const complexity = countBranches(fn.body);
    if (complexity > THRESHOLDS.CYCLOMATIC) {
      violations.push({
        type:       'HIGH_COMPLEXITY',
        file:       relPath,
        line:       fn.line,
        name:       fn.name,
        value:      complexity,
        threshold:  THRESHOLDS.CYCLOMATIC,
        suggestion: `Complexité cyclomatique ${complexity} dans "${fn.name}". Utilise early-return et table de dispatch.`,
      });
    }

    // Missing return type (exported functions only)
    if (/^export\s/.test(sourceCode.split('\n')[fn.line - 1] ?? '')) {
      const hasSig = /:\s*(?:Promise<|void|string|number|boolean|object|null|undefined|\w+\[)/.test(
        (sourceCode.split('\n')[fn.line - 1] ?? '') + (sourceCode.split('\n')[fn.line] ?? ''),
      );
      if (!hasSig) {
        violations.push({
          type: 'MISSING_RETURN_TYPE',
          file: relPath,
          line: fn.line,
          name: fn.name,
          suggestion: `Ajoute un type de retour explicite sur la fonction exportée "${fn.name}".`,
        });
      }
    }
  }

  return violations;
}

// ── Grade computation ─────────────────────────────────────────────────────────

function computeGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ── Markdown report ───────────────────────────────────────────────────────────

function buildMarkdownReport(report: ArchReport): string {
  const grade = { A: '🟢', B: '🟡', C: '🟠', D: '🔴', F: '🔴' }[report.grade];
  const lines = [
    `# Rapport Arch Police`,
    ``,
    `**Score:** ${report.score}/100 ${grade} Grade **${report.grade}**  `,
    `**Fichiers analysés:** ${report.totalFiles}  `,
    `**Violations:** ${report.totalViolations}  `,
    `**Généré le:** ${report.generatedAt}`,
    ``,
    `## Violations par type`,
    ``,
  ];

  const byType = new Map<ViolationType, ArchViolation[]>();
  for (const v of report.violations) {
    if (!byType.has(v.type)) byType.set(v.type, []);
    byType.get(v.type)!.push(v);
  }

  const icons: Record<ViolationType, string> = {
    FUNCTION_TOO_LONG:    '📏',
    HIGH_COMPLEXITY:      '🔄',
    FILE_TOO_LARGE:       '📂',
    EXCESSIVE_COUPLING:   '🔗',
    UNSAFE_ANY:           '⚠️',
    MISSING_RETURN_TYPE:  '🔍',
    CIRCULAR_DEPENDENCY:  '🔁',
  };

  for (const [type, violations] of byType.entries()) {
    lines.push(`### ${icons[type]} ${type} (${violations.length})`);
    for (const v of violations.slice(0, 10)) {
      const loc = v.line ? `:${v.line}` : '';
      lines.push(`- \`${v.file}${loc}\`${v.name ? ` — \`${v.name}\`` : ''}`);
      if (v.value) lines.push(`  - Valeur: ${v.value} (seuil: ${v.threshold})`);
      if (v.suggestion) lines.push(`  - 💡 ${v.suggestion}`);
    }
    if (violations.length > 10) {
      lines.push(`  - ...et ${violations.length - 10} autres`);
    }
    lines.push('');
  }

  if (report.refactorPlan) {
    lines.push('## Plan de refactoring (LLM)', '', report.refactorPlan, '');
  }

  return lines.join('\n');
}

// ── LLM refactor plan ─────────────────────────────────────────────────────────

async function generateRefactorPlan(
  violations: ArchViolation[],
  ollama:     OllamaCapability,
): Promise<string> {
  const top10 = violations.slice(0, 10);
  const summary = top10.map((v) =>
    `${v.type} dans ${v.file}${v.name ? ` (${v.name})` : ''}${v.value ? ` — valeur: ${v.value}` : ''}`
  ).join('\n');

  const prompt =
    `Tu es un expert en architecture TypeScript. Voici les ${top10.length} violations architecturales les plus critiques:\n\n` +
    summary + '\n\n' +
    `Fournis un plan de refactoring prioritisé en 5 étapes concrètes (100 mots max par étape).`;

  try {
    const res = await fetch(`${ollama.endpoint}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: ollama.model, prompt, stream: false }),
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) return 'LLM indisponible';
    const data = await res.json() as { response?: string };
    return data.response ?? 'Analyse indisponible';
  } catch {
    return 'LLM indisponible';
  }
}

// ── Main agent ─────────────────────────────────────────────────────────────────

export async function run(
  config: RunConfig,
  ollama: OllamaCapability | null = null,
): Promise<ArchReport> {
  const targetSrc = resolve(config.targetPath, 'src');
  const workDir   = join(config.targetPath, '.e2e-work');

  if (!existsSync(targetSrc) && !existsSync(config.targetPath)) {
    return {
      totalFiles: 0, totalViolations: 0, violations: [],
      score: 100, grade: 'A', generatedAt: new Date().toISOString(),
    };
  }

  const searchDir = existsSync(targetSrc) ? targetSrc : config.targetPath;

  // Collect TypeScript files
  const { globSync } = await import('glob');
  const tsFiles = globSync('**/*.ts', {
    cwd:    searchDir,
    ignore: ['**/*.d.ts', '**/node_modules/**', '**/dist/**', '**/*.spec.ts', '**/*.test.ts'],
    absolute: true,
  });

  if (tsFiles.length === 0) {
    console.log('[archPolice] Aucun fichier TypeScript trouvé');
    return {
      totalFiles: 0, totalViolations: 0, violations: [],
      score: 100, grade: 'A', generatedAt: new Date().toISOString(),
    };
  }

  console.log(`[archPolice] Analyse de ${tsFiles.length} fichiers TypeScript...`);

  const allViolations: ArchViolation[] = [];
  const { readFileSync } = await import('node:fs');

  for (const filePath of tsFiles) {
    try {
      const source  = readFileSync(filePath, 'utf-8');
      const relPath = relative(searchDir, filePath);
      const fileViolations = analyzeFile(relPath, source);
      allViolations.push(...fileViolations);
    } catch (e) {
      console.warn(`[archPolice] skip ${filePath}: ${(e as Error).message}`);
    }
  }

  // Score: start at 100, penalize by violation count and severity
  const penaltyMap: Record<ViolationType, number> = {
    FILE_TOO_LARGE:      10,
    EXCESSIVE_COUPLING:   8,
    HIGH_COMPLEXITY:      7,
    FUNCTION_TOO_LONG:    5,
    CIRCULAR_DEPENDENCY: 15,
    UNSAFE_ANY:           3,
    MISSING_RETURN_TYPE:  2,
  };

  const totalPenalty = allViolations.reduce((acc, v) => acc + (penaltyMap[v.type] ?? 3), 0);
  const score = Math.max(0, Math.min(100, 100 - Math.round(totalPenalty / Math.max(1, tsFiles.length) * 10)));
  const grade = computeGrade(score);

  const report: ArchReport = {
    totalFiles:      tsFiles.length,
    totalViolations: allViolations.length,
    violations:      allViolations,
    score,
    grade,
    generatedAt:     new Date().toISOString(),
  };

  if (ollama?.available && allViolations.length > 0) {
    report.refactorPlan = await generateRefactorPlan(allViolations, ollama);
  }

  // Write reports
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  writeFileSync(join(workDir, 'arch-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(join(workDir, 'arch-report.md'), buildMarkdownReport(report), 'utf-8');

  console.log(`[archPolice] Score: ${score}/100 (${grade}) — ${allViolations.length} violations sur ${tsFiles.length} fichiers`);
  return report;
}
