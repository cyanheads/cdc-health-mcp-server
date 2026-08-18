# cdc-health-mcp-server - Directory Structure

Generated on: 2026-08-18 06:18:38

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
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── claude-plans/
├── docs/
│   └── design.md
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
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
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
│   │           ├── query-dataset.tool.ts
│   │           └── query-wonder.tool.ts
│   ├── services/
│   │   ├── socrata/
│   │   │   ├── socrata-service.ts
│   │   │   └── types.ts
│   │   └── wonder/
│   │       ├── types.ts
│   │       ├── wonder-service.ts
│   │       ├── xml-builder.ts
│   │       └── xml-parser.ts
│   ├── utils/
│   │   └── markdown.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config-edge.test.ts
│   │   └── server-config.test.ts
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
│   │           ├── query-dataset-edge.tool.test.ts
│   │           ├── query-dataset.tool.test.ts
│   │           └── query-wonder.tool.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── security/
│   │   └── tools-security.test.ts
│   ├── services/
│   │   ├── socrata/
│   │   │   ├── socrata-contract-parity.test.ts
│   │   │   ├── socrata-domain-semantics.test.ts
│   │   │   ├── socrata-service-errors.test.ts
│   │   │   ├── socrata-service-token.test.ts
│   │   │   └── socrata-service.test.ts
│   │   └── wonder/
│   │       ├── database-ids.test.ts
│   │       ├── wonder-service.test.ts
│   │       ├── xml-builder.test.ts
│   │       └── xml-parser.test.ts
│   └── tools/
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
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
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
