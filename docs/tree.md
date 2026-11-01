# cdc-health-mcp-server - Directory Structure

Generated on: 2026-11-01 08:00:39

```text
cdc-health-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.10.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   ├── 0.8.x/
│   ├── 0.9.x/
│   └── template.md
├── claude-plans/
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   └── cdc-health-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── analyze-health-trend.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── dataset-detail.resource.ts
│   │   │       └── datasets.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── discover-datasets.tool.ts
│   │           ├── get-dataset-schema.tool.ts
│   │           ├── list-catalog-vocabulary.tool.ts
│   │           ├── query-dataset.tool.ts
│   │           └── query-wonder.tool.ts
│   ├── services/
│   │   ├── socrata/
│   │   │   ├── socrata-service.ts
│   │   │   └── types.ts
│   │   ├── wonder/
│   │   │   ├── types.ts
│   │   │   ├── wonder-service.ts
│   │   │   ├── xml-builder.ts
│   │   │   └── xml-parser.ts
│   │   └── user-agent.ts
│   ├── utils/
│   │   ├── markdown.ts
│   │   ├── text.ts
│   │   └── vocabulary.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config-edge.test.ts
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   └── wonder/
│   │       ├── d157-injury-intent-2023.response.xml
│   │       ├── d158-a82-2018-2024-both-hidden.response.xml
│   │       ├── d158-a82-2021-suppressed-rows-hidden.response.xml
│   │       ├── d158-duplicate-race-group-by.response.xml
│   │       ├── d158-leading-causes-2023.response.xml
│   │       ├── d158-race-age-c00-2024.response.xml
│   │       ├── d176-2025-2026-partial-year.response.xml
│   │       ├── d176-hispanic-origin-2025.response.xml
│   │       ├── d176-icd-chapter-2026-lag.response.xml
│   │       ├── d176-icd-subchapter-all-years.response.xml
│   │       ├── d176-month-2026.response.xml
│   │       ├── d176-overdose-2025-2026-lag.response.xml
│   │       ├── d176-withheld-cause-all-years.response.xml
│   │       ├── d76-c61-female-2019-zero-rows-hidden.response.xml
│   │       ├── d76-icd-chapter-2019.response.xml
│   │       ├── d76-icd-chapter-and-subchapter.response.xml
│   │       ├── d76-leading-causes-beside-year-rejected.response.xml
│   │       ├── d76-x40-x44-by-year-2018-2019.response.xml
│   │       ├── d76-x40-x49-year-age-1999-2001-intervals.response.xml
│   │       ├── d76-year-age-sex-race.response.xml
│   │       ├── d76-year-month-2019.response.xml
│   │       ├── d77-2019-intervals.response.xml
│   │       ├── d77-cause-113-2019.response.xml
│   │       └── d77-overdose-ucd-opioid-mcd-2019.response.xml
│   ├── helpers/
│   │   ├── contract-error.ts
│   │   ├── contract-text.ts
│   │   ├── cpu-cost.ts
│   │   ├── markdown-render.ts
│   │   └── resource-read.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── analyze-health-trend.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── dataset-detail-edge.resource.test.ts
│   │   │       ├── dataset-detail.resource.test.ts
│   │   │       ├── datasets-edge.resource.test.ts
│   │   │       └── datasets.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── discover-datasets-edge.tool.test.ts
│   │           ├── discover-datasets.tool.test.ts
│   │           ├── get-dataset-schema-edge.tool.test.ts
│   │           ├── get-dataset-schema.tool.test.ts
│   │           ├── list-catalog-vocabulary.tool.test.ts
│   │           ├── query-dataset-edge.tool.test.ts
│   │           ├── query-dataset-response.tool.test.ts
│   │           ├── query-dataset.tool.test.ts
│   │           ├── query-wonder.input-seam.test.ts
│   │           ├── query-wonder.paging.test.ts
│   │           ├── query-wonder.service-seam.test.ts
│   │           └── query-wonder.tool.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── scripts/
│   │   └── mcpb-agent-doc-entry.test.ts
│   ├── security/
│   │   └── tools-security.test.ts
│   ├── services/
│   │   ├── socrata/
│   │   │   ├── socrata-contract-parity.test.ts
│   │   │   ├── socrata-domain-semantics.test.ts
│   │   │   ├── socrata-service-errors.test.ts
│   │   │   ├── socrata-service-failures.test.ts
│   │   │   ├── socrata-service-token.test.ts
│   │   │   ├── socrata-service.test.ts
│   │   │   └── socrata-upstream-error-wiring.test.ts
│   │   └── wonder/
│   │       ├── database-ids.test.ts
│   │       ├── types.test.ts
│   │       ├── wonder-service.test.ts
│   │       ├── xml-builder.test.ts
│   │       └── xml-parser.test.ts
│   ├── tools/
│   └── utils/
│       ├── markdown.test.ts
│       ├── text.test.ts
│       └── vocabulary.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
