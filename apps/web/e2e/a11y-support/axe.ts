import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { SCHEMES, atRest, useScheme } from './screens.js';

/** The rule sets of the gate: WCAG 2.0, 2.1 and 2.2 at levels A and AA (spec 09 §1). */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const BLOCKING = new Set(['serious', 'critical']);

export interface Finding {
  where: string;
  rule: string;
  impact: string;
  help: string;
  /** The elements that broke the rule, as axe selects them. */
  targets: string[];
}

export interface ScanOptions {
  /** A modal is open and the page behind it is inert: only the open dialogs are checked. */
  modal?: boolean;
}

/** Runs axe on the screens a test visits, prints every violation it finds and keeps them. */
export class AxeGate {
  readonly findings: Finding[] = [];
  private scans = 0;

  async scan(page: Page, where: string, { modal = false }: ScanOptions = {}): Promise<void> {
    await atRest(page);
    const builder = new AxeBuilder({ page }).withTags(TAGS);
    if (modal) builder.include('dialog[open]');
    const { violations } = await builder.analyze();
    this.scans += 1;
    console.log(`axe | ${where} | ${violations.length} violation(s)`);
    for (const violation of violations) {
      const finding: Finding = {
        where,
        rule: violation.id,
        impact: violation.impact ?? 'none',
        help: violation.help,
        targets: violation.nodes.map((node) => node.target.join(' ')),
      };
      this.findings.push(finding);
      console.log(
        `axe |   ${finding.impact} ${finding.rule}: ${finding.help} (${finding.targets.length} element(s))`,
      );
      for (const target of finding.targets) console.log(`axe |     ${target}`);
    }
  }

  /** The same screen in the light theme and in the dark one. */
  async scanBoth(page: Page, where: string, options: ScanOptions = {}): Promise<void> {
    for (const scheme of SCHEMES) {
      await useScheme(page, scheme);
      await this.scan(page, `${where}, ${scheme}`, options);
    }
  }

  /** What fails the gate: the violations that are serious or critical. */
  blocking(): string[] {
    return this.findings
      .filter((finding) => BLOCKING.has(finding.impact))
      .map(
        (finding) =>
          `${finding.where}: ${finding.impact} ${finding.rule}: ${finding.help} at ${finding.targets.join(' | ')}`,
      );
  }

  summary(): string {
    return `${this.scans} screen(s) scanned, ${this.findings.length} violation(s), ${this.blocking().length} serious or critical`;
  }
}
