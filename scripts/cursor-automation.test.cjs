'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const auto = require('./cursor-automation.cjs');

test('isValidIssueFormat accepts modern bug template', () => {
  assert.equal(
    auto.isValidIssueFormat({
      title: '[Bug] SFTP upload fails on Windows',
      body: [
        '## Describe the problem',
        'Upload fails on large files.',
        '## Steps to reproduce',
        '1. open sftp',
        '2. upload',
        '## Expected behavior',
        'success',
        '## Actual behavior',
        'error',
        '## Operating system',
        'Windows 11',
      ].join('\n'),
    }),
    true,
  );
});

test('isValidIssueFormat rejects short bodies', () => {
  assert.equal(
    auto.isValidIssueFormat({
      title: '[Bug] too short',
      body: 'Steps to reproduce: nope',
    }),
    false,
  );
});

test('normalizeClassification downgrades low-confidence bug_ready', () => {
  const result = auto.normalizeClassification({
    category: 'bug_ready',
    confidence: 0.4,
    summary: 'maybe',
    reasoning: 'unclear',
    reply: 'Need more info please.',
  });
  assert.equal(result.category, 'bug_needs_info');
  assert.equal(result.should_implement, false);
});

test('normalizeClassification keeps high-confidence quick win', () => {
  const result = auto.normalizeClassification({
    category: 'feature_quick_win',
    confidence: 0.9,
    summary: 'small ui tweak',
    reasoning: 'localized',
    reply: 'Working on it.',
  });
  assert.equal(result.category, 'feature_quick_win');
  assert.equal(result.should_implement, true);
});

test('labelsForCategory swaps bug/enhancement correctly', () => {
  const labels = auto.labelsForCategory('bug_ready', [
    'enhancement',
    'needs-triage',
    'user-tag',
  ]);
  assert.ok(labels.includes('bug'));
  assert.ok(labels.includes('ready-for-agent'));
  assert.ok(labels.includes('user-tag'));
  assert.ok(!labels.includes('enhancement'));
  assert.ok(!labels.includes('needs-triage'));
});

test('isFixEligiblePr allows bot marker on same-repo branch', () => {
  const pr = {
    user: { login: 'random-contributor' },
    body: `${auto.BOT_PR_MARKER}\nFixes #1`,
    head: {
      ref: 'cursor/issue-1-99',
      repo: { full_name: 'binaricat/Netcatty' },
    },
    base: { repo: { full_name: 'binaricat/Netcatty' } },
    labels: [],
  };
  assert.equal(auto.isFixEligiblePr(pr, { repository: 'binaricat/Netcatty' }), true);
});

test('isFixEligiblePr rejects forks', () => {
  const pr = {
    user: { login: 'binaricat' },
    body: auto.BOT_PR_MARKER,
    head: {
      ref: 'cursor/issue-1-99',
      repo: { full_name: 'someone/Netcatty' },
    },
    base: { repo: { full_name: 'binaricat/Netcatty' } },
    labels: ['automation:bot-pr'],
  };
  assert.equal(auto.isFixEligiblePr(pr), false);
});

test('isFixEligiblePr allows maintainer same-repo PRs', () => {
  const pr = {
    user: { login: 'binaricat' },
    body: 'manual pr',
    head: {
      ref: 'feature/foo',
      repo: { full_name: 'binaricat/Netcatty' },
    },
    base: { repo: { full_name: 'binaricat/Netcatty' } },
    labels: [],
  };
  assert.equal(auto.isFixEligiblePr(pr), true);
});

test('parseCodexReviewOutcome detects clean summary', () => {
  const outcome = auto.parseCodexReviewOutcome({
    summaryText: "Codex Review: Didn't find any major issues. Swish!",
    reviewComments: [],
  });
  assert.equal(outcome.clean, true);
  assert.equal(outcome.actionable, false);
});

test('parseCodexReviewOutcome detects P2 findings on current head', () => {
  const outcome = auto.parseCodexReviewOutcome({
    summaryText: 'Codex Review finished with findings',
    headSha: 'abc123',
    reviewComments: [
      {
        body: '**![P2 Badge](https://img.shields.io/badge/P2-yellow)** Null deref',
        path: 'src/a.ts',
        commit_id: 'abc123',
      },
    ],
  });
  assert.equal(outcome.clean, false);
  assert.equal(outcome.actionable, true);
});

test('parseCodexReviewOutcome ignores stale head inlines when summary clean', () => {
  const outcome = auto.parseCodexReviewOutcome({
    summaryText: "Codex Review: Didn't find any major issues. Swish!",
    headSha: 'newsha',
    reviewComments: [
      {
        body: '![P2 Badge](x) old bug',
        commit_id: 'oldsha',
      },
    ],
  });
  assert.equal(outcome.clean, true);
});

test('parseCodexReviewOutcome unknown is not actionable', () => {
  const outcome = auto.parseCodexReviewOutcome({
    summaryText: 'Codex is still thinking',
    reviewComments: [],
  });
  assert.equal(outcome.clean, false);
  assert.equal(outcome.actionable, false);
  assert.equal(outcome.reason, 'codex_unknown');
});

test('decideCodexLoopAction skips when awaiting existing @codex request', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasAutomationRequest: true,
    hasCodexActivity: false,
    outcome: { clean: false, actionable: false, reason: 'codex_unknown' },
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'awaiting_codex');
});

test('decideCodexLoopAction ignores stale clean summary for other head', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasCodexActivity: true,
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    summaryText:
      "Codex Review: Didn't find any major issues. Swish!\n**Reviewed commit:** `bbbbbbb`",
    outcome: { clean: true, actionable: false, reason: 'codex_clean_summary' },
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'stale_clean_summary');
});

test('decideCodexLoopAction awaits when request is newer than summary', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasCodexActivity: true,
    lastAutomationRequestAt: 2000,
    lastCodexSummaryAt: 1000,
    outcome: { clean: true, actionable: false, reason: 'codex_clean_summary' },
    summaryText: "Didn't find any major issues. Swish!",
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'awaiting_codex_for_new_head');
});

test('decideCodexLoopAction still fixes inline-only findings after request', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasCodexActivity: true,
    lastAutomationRequestAt: 2000,
    lastCodexSummaryAt: 0,
    round: 1,
    maxRounds: 40,
    outcome: { clean: false, actionable: true, reason: 'codex_inline_findings' },
  });
  assert.equal(d.action, 'fix');
});
test('extractReviewedCommitSha parses Codex marker', () => {
  assert.equal(
    auto.extractReviewedCommitSha(
      'Codex Review\n**Reviewed commit:** `fd871e86f1`\n',
    ),
    'fd871e86f1',
  );
});

test('decideCodexLoopAction requests review when no activity', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasAutomationRequest: false,
    hasCodexActivity: false,
  });
  assert.equal(d.action, 'request_review');
});

test('decideCodexLoopAction fixes only actionable dirty', () => {
  const d = auto.decideCodexLoopAction({
    eligible: true,
    hasCodexActivity: true,
    round: 1,
    maxRounds: 40,
    outcome: { clean: false, actionable: true, reason: 'codex_findings' },
  });
  assert.equal(d.action, 'fix');
});

test('shouldReTriageIssueComment only for author on needs-info', () => {
  assert.equal(
    auto.shouldReTriageIssueComment({
      labels: ['needs-info'],
      commenterLogin: 'alice',
      issueAuthorLogin: 'alice',
    }),
    true,
  );
  assert.equal(
    auto.shouldReTriageIssueComment({
      labels: ['needs-info'],
      commenterLogin: 'bob',
      issueAuthorLogin: 'alice',
    }),
    false,
  );
  assert.equal(
    auto.shouldReTriageIssueComment({
      labels: ['bug'],
      commenterLogin: 'alice',
      issueAuthorLogin: 'alice',
    }),
    false,
  );
});

test('normalizeClassification does not auto-close low-confidence unclear', () => {
  const result = auto.normalizeClassification({
    category: 'unclear',
    confidence: 0.3,
    summary: 'vague',
    reasoning: 'no detail',
    reply: 'Please clarify',
  });
  assert.equal(result.category, 'bug_needs_info');
  assert.equal(result.should_implement, false);
  assert.match(result.reply, /Please clarify|more detail/i);
});

test('normalizeClassification replaces closing-language unclear replies', () => {
  const result = auto.normalizeClassification({
    category: 'unclear',
    confidence: 0.2,
    summary: 'vague',
    reasoning: 'no detail',
    reply: 'This issue will be closed as unclear.',
  });
  assert.equal(result.category, 'bug_needs_info');
  assert.doesNotMatch(result.reply, /will be closed/i);
});

test('normalizeClassification keeps localized low-confidence bug reply', () => {
  const result = auto.normalizeClassification({
    category: 'bug_ready',
    confidence: 0.5,
    summary: 'maybe',
    reasoning: 'unclear',
    reply: '请补充复现步骤和日志。',
  });
  assert.equal(result.category, 'bug_needs_info');
  assert.equal(result.reply, '请补充复现步骤和日志。');
});
test('isBotPrForIssue matches marker + Fixes', () => {
  assert.equal(
    auto.isBotPrForIssue(
      {
        body: `${auto.BOT_PR_MARKER}\nFixes #42`,
        head: { ref: 'cursor/issue-42-1', repo: { full_name: 'o/r' } },
        base: { repo: { full_name: 'o/r' } },
        labels: [],
      },
      42,
    ),
    true,
  );
});

test('hasProtectedChangesInSources checks commit names', () => {
  const hits = auto.hasProtectedChangesInSources({
    gitStatusPorcelain: '',
    changedFiles: ['.github/workflows/x.yml', 'src/a.ts'],
  });
  assert.deepEqual(hits, ['.github/workflows/x.yml']);
});

test('pathsFromGitStatusPorcelain keeps both rename sides', () => {
  const paths = auto.pathsFromGitStatusPorcelain(
    'R  scripts/cursor-automation.cjs -> scripts/evil.cjs\n',
  );
  assert.ok(paths.includes('scripts/cursor-automation.cjs'));
  assert.ok(paths.includes('scripts/evil.cjs'));
});

test('pathsFromGitDiffNameStatus keeps rename source and dest', () => {
  const paths = auto.pathsFromGitDiffNameStatus(
    'R100\t.github/workflows/x.yml\tunprotected.yml\nM\tsrc/a.ts\n',
  );
  assert.ok(paths.includes('.github/workflows/x.yml'));
  assert.ok(paths.includes('unprotected.yml'));
  assert.ok(paths.includes('src/a.ts'));
  const hits = auto.hasProtectedChangesInSources({
    nameStatusText: 'R100\t.github/workflows/x.yml\tunprotected.yml\n',
  });
  assert.deepEqual(hits, ['.github/workflows/x.yml']);
});
test('extractJsonObject reads fenced blocks', () => {
  const obj = auto.extractJsonObject(
    'Here you go:\n```json\n{"category":"unclear","confidence":0.9,"summary":"x","reasoning":"y","reply":"please clarify the steps"}\n```\n',
  );
  assert.equal(obj.category, 'unclear');
});

test('hasProtectedChanges flags workflow edits', () => {
  const hits = auto.hasProtectedChanges(
    ' M .github/workflows/cursor-automation.yml\n M components/App.tsx\n',
  );
  assert.deepEqual(hits, ['.github/workflows/cursor-automation.yml']);
});

test('shouldSkipExternalCodexRerequest matches head sha marker', () => {
  const sha = 'abc123';
  assert.equal(
    auto.shouldSkipExternalCodexRerequest({
      headSha: sha,
      existingComments: [
        { body: auto.buildExternalCodexRerequestComment(sha) },
      ],
    }),
    true,
  );
  assert.equal(
    auto.shouldSkipExternalCodexRerequest({
      headSha: sha,
      existingComments: [{ body: 'unrelated' }],
    }),
    false,
  );
});

test('buildExternalCodexRerequestComment only asks Codex', () => {
  const body = auto.buildExternalCodexRerequestComment('deadbeef');
  assert.match(body, /@codex review/);
  assert.match(body, /cursor-external-codex:deadbeef/);
  assert.doesNotMatch(body, /Cursor CLI/i);
});

test('getCodexRoundFromComments reads max round', () => {
  assert.equal(
    auto.getCodexRoundFromComments([
      { body: '<!-- cursor-codex-round:1 -->' },
      { body: '<!-- cursor-codex-round:3 -->' },
    ]),
    3,
  );
});

test('parseClassificationFile accepts pure JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-auto-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      category: 'bug_needs_info',
      confidence: 0.7,
      summary: 'need logs',
      reasoning: 'missing repro',
      reply: 'Can you share logs?',
    }),
  );
  const parsed = auto.parseClassificationFile(file);
  assert.equal(parsed.category, 'bug_needs_info');
});

test('buildCodexReviewRequestComment includes mention', () => {
  const body = auto.buildCodexReviewRequestComment(2);
  assert.match(body, /@codex review/);
  assert.match(body, /cursor-codex-round:2/);
});
