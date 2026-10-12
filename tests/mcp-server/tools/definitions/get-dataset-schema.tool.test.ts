/**
 * @fileoverview Tests for cdc_get_dataset_schema tool.
 * @module tests/mcp-server/tools/definitions/get-dataset-schema
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';
import {
  contentText,
  readBack,
  renderedCells,
  renderMarkdown,
  strayElements,
} from '../../../helpers/markdown-render.js';

const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ getMetadata: mockGetMetadata }),
}));

const sampleMetadata: DatasetMetadata = {
  name: 'Diabetes Mortality',
  description: 'State-level diabetes death rates',
  rowCount: 50000,
  updatedAt: '2024-06-01T00:00:00.000Z',
  columns: [
    { fieldName: 'state', dataType: 'text', description: 'US state name' },
    { fieldName: 'year', dataType: 'number', description: 'Data year' },
    { fieldName: 'deaths', dataType: 'number', description: 'Number of deaths' },
  ],
};

describe('cdc_get_dataset_schema', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns metadata for a valid dataset ID', async () => {
    mockGetMetadata.mockResolvedValue(sampleMetadata);
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await getDatasetSchema.handler(input, ctx);

    expect(result.name).toBe('Diabetes Mortality');
    expect(result.rowCount).toBe(50000);
    expect(result.columns).toHaveLength(3);
    // Default domain is threaded as the third argument.
    expect(mockGetMetadata).toHaveBeenCalledWith('bi63-dtpu', ctx.signal, 'data.cdc.gov');
  });

  describe('row count provenance', () => {
    it('carries a live-derived count and its provenance on both surfaces', async () => {
      /**
       * Socrata's cached figure is built once and never refreshed, so it can badly understate
       * an actively-updated dataset. A caller sizing a pagination walk against it stops early,
       * and nothing in the response said which figure it was looking at.
       */
      mockGetMetadata.mockResolvedValue({
        ...sampleMetadata,
        rowCount: 218_700,
        rowCountSource: 'live',
      });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: '4va6-ph5s' }),
        ctx,
      );

      // Route the result through the declared output schema: calling the handler directly
      // bypasses Zod, so a field missing from `output` would otherwise pass unnoticed.
      const parsed = getDatasetSchema.output.parse(result);
      expect(parsed.rowCount).toBe(218_700);
      expect(parsed.rowCountSource).toBe('live');

      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Rows:** 218,700 (live count)');
    });

    it('says in both surfaces when the count fell back to the cached figure', async () => {
      mockGetMetadata.mockResolvedValue({
        ...sampleMetadata,
        rowCount: 139_968,
        rowCountSource: 'cached',
      });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: '4va6-ph5s' }),
        ctx,
      );

      expect(getDatasetSchema.output.parse(result).rowCountSource).toBe('cached');
      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('139,968 (cached count');
    });

    it('renders an em dash and no provenance when upstream reports no row count', async () => {
      mockGetMetadata.mockResolvedValue({ name: 'No Count', columns: sampleMetadata.columns });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }),
        ctx,
      );

      expect(getDatasetSchema.output.parse(result).rowCountSource).toBeUndefined();
      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Rows:** — |');
    });

    it('returns a description under the cap whole and renders it in content[]', async () => {
      /** Most catalog descriptions sit well under the cap; those arrive untouched. */
      const description = `${'Long prose. '.repeat(60)}end.`;
      mockGetMetadata.mockResolvedValue({ ...sampleMetadata, description });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' }),
        ctx,
      );

      expect(result.description).toBe(description);
      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(text).toContain(description);
    });

    it('names the staleness of the cached figure in the rowCount description', () => {
      /**
       * The field used to be advertised as the dataset's row count with no qualifier, which
       * is the whole reason a caller trusted a figure that was two thirds of the real total.
       */
      const shape = getDatasetSchema.output.shape;
      expect(shape.rowCount.description).toMatch(/cached/i);
      expect(shape.rowCount.description).toContain('rowCountSource');
      expect(shape.rowCountSource.description).toMatch(/count\(\*\)/);
    });
  });

  it('threads an explicit domain through to getMetadata', async () => {
    mockGetMetadata.mockResolvedValue(sampleMetadata);
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({
      datasetId: 'swc5-untb',
      domain: 'chronicdata.cdc.gov',
    });
    await getDatasetSchema.handler(input, ctx);

    expect(mockGetMetadata).toHaveBeenCalledWith('swc5-untb', ctx.signal, 'chronicdata.cdc.gov');
  });

  it('defaults domain to data.cdc.gov', () => {
    expect(getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' }).domain).toBe('data.cdc.gov');
  });

  it('rejects invalid dataset ID format', () => {
    expect(() => getDatasetSchema.input.parse({ datasetId: 'invalid' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: 'ABCD-1234' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: '' })).toThrow();
  });

  it('propagates service errors', async () => {
    mockGetMetadata.mockRejectedValue(new Error('Dataset not found (404).'));
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    await expect(getDatasetSchema.handler(input, ctx)).rejects.toThrow(/not found/);
  });

  describe('column window', () => {
    /** A schema the width of ua7e-t2fy (Weekly Hospital Respiratory Data). */
    const wideMetadata: DatasetMetadata = {
      name: 'Weekly Hospital Respiratory Data',
      columns: Array.from({ length: 322 }, (_, i) => ({
        fieldName: `col_${i}`,
        dataType: 'number',
        description: `Description of column ${i}`,
      })),
    };

    it('returns a narrow schema whole and reports its column total', async () => {
      mockGetMetadata.mockResolvedValue(sampleMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(3);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
    });

    it('bounds a 322-column schema at the default window and points at the next page', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'ua7e-t2fy' });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(100);
      expect(result.columns[0]?.fieldName).toBe('col_0');
      expect(result.columns[99]?.fieldName).toBe('col_99');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(322);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(100);
      expect(enrichment.cap).toBe(100);
      expect(enrichment.nextOffset).toBe(100);
      // No maximum is quoted: column_limit only slices a schema already fetched whole.
      expect(enrichment.notice).toBe(
        'Showing columns 1–100 of 322. Call again with column_offset=100 for the next window, or raise column_limit to pull more per call.',
      );
    });

    it('keeps selected column descriptions whole rather than truncating them', async () => {
      const longDescription = 'D'.repeat(1200);
      mockGetMetadata.mockResolvedValue({
        name: 'Verbose',
        columns: [{ fieldName: 'a', dataType: 'text', description: longDescription }],
      });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }),
        ctx,
      );
      expect(result.columns[0]?.description).toBe(longDescription);
    });

    it('continues from an explicit column_offset', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_offset: 100,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns[0]?.fieldName).toBe('col_100');
      expect(result.columns).toHaveLength(100);
      expect(getEnrichment(ctx).nextOffset).toBe(200);
    });

    it('returns the final page without a nextOffset', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_offset: 300,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(22);
      expect(result.columns[21]?.fieldName).toBe('col_321');
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toContain('322');
    });

    it('reaches every column across a sequence of calls', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const ctx = createMockContext({ errors: getDatasetSchema.errors });
        const input = getDatasetSchema.input.parse({
          datasetId: 'ua7e-t2fy',
          column_offset: offset,
        });
        const page = await getDatasetSchema.handler(input, ctx);
        seen.push(...page.columns.map((c) => c.fieldName));
        offset = getEnrichment(ctx).nextOffset as number | undefined;
      }
      expect(seen).toHaveLength(322);
      expect(new Set(seen).size).toBe(322);
    });

    it('returns the whole wide schema when column_limit is raised', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_limit: 500,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(322);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(322);
      expect(enrichment.truncated).toBeUndefined();
    });

    it('renders the windowed columns in content[] as well as structuredContent', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_limit: 5,
        column_offset: 10,
      });
      const result = await getDatasetSchema.handler(input, ctx);
      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;

      for (const column of result.columns) expect(text).toContain(`\`${column.fieldName}\``);
      expect(text).toContain('Description of column 14');
      expect(text).not.toContain('`col_15`');
    });
  });

  describe('dataset description cap', () => {
    /** ua7e-t2fy's description is 32,394 characters of plain text; its columns are short. */
    const LONG = `${'Weekly hospital respiratory reporting. '.repeat(830)}End of notes.`;
    const longMetadata: DatasetMetadata = {
      name: 'Weekly Hospital Respiratory Data',
      description: LONG,
      columns: Array.from({ length: 322 }, (_, i) => ({
        fieldName: `col_${i}`,
        dataType: 'number',
        description: `Description of column ${i} — ${'detail '.repeat(i % 5)}`,
      })),
    };
    const cutLine = (length: number) =>
      `**Description:** shortened to at most 4,000 of its ${length.toLocaleString('en-US')} characters — call again with full_description: true for the whole text.`;

    it('caps a long description at 4,000 characters and discloses the cut on both surfaces', async () => {
      mockGetMetadata.mockResolvedValue(longMetadata);
      const result = await runToolContract(getDatasetSchema, {
        datasetId: 'ua7e-t2fy',
        column_limit: 2,
      });

      const wire = result.structuredContent as {
        description: string;
        descriptionTruncated?: boolean;
        descriptionLength?: number;
        columns: unknown[];
      };
      expect(wire.description.length).toBeLessThanOrEqual(4001);
      expect(wire.description.endsWith('…')).toBe(true);
      expect(LONG.startsWith(wire.description.slice(0, -1).trimEnd())).toBe(true);
      expect(wire.descriptionTruncated).toBe(true);
      expect(wire.descriptionLength).toBe(LONG.length);
      expect(wire.columns).toHaveLength(2);

      const rendered = contentText(result);
      expect(rendered).toContain(`${wire.description}\n\n${cutLine(LONG.length)}\n\n**Rows:**`);
      expect(rendered).not.toContain('End of notes.');
    });

    it('returns the whole description with neither cut field when full_description is true', async () => {
      mockGetMetadata.mockResolvedValue(longMetadata);
      for (const column_offset of [0, 2, 321]) {
        const result = await runToolContract(getDatasetSchema, {
          datasetId: 'ua7e-t2fy',
          column_limit: 2,
          column_offset,
          full_description: true,
        });

        const wire = result.structuredContent as Record<string, unknown>;
        expect(wire.description).toBe(LONG);
        expect(wire).not.toHaveProperty('descriptionTruncated');
        expect(wire).not.toHaveProperty('descriptionLength');
        const rendered = contentText(result);
        expect(rendered).toContain('End of notes.');
        expect(rendered).not.toContain('full_description');
      }
    });

    it('treats an omitted full_description and false identically', async () => {
      mockGetMetadata.mockResolvedValue(longMetadata);
      const omitted = await runToolContract(getDatasetSchema, { datasetId: 'ua7e-t2fy' });
      const explicit = await runToolContract(getDatasetSchema, {
        datasetId: 'ua7e-t2fy',
        full_description: false,
      });

      expect(explicit.structuredContent).toEqual(omitted.structuredContent);
      expect(contentText(explicit)).toBe(contentText(omitted));
    });

    it.each([
      { length: 4000, cut: false },
      { length: 4001, cut: true },
    ])('cuts a description of $length characters: $cut', async ({ length, cut }) => {
      const description = `${'x'.repeat(length - 1)}y`;
      mockGetMetadata.mockResolvedValue({ ...sampleMetadata, description });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = getDatasetSchema.output.parse(
        await getDatasetSchema.handler(
          getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }),
          ctx,
        ),
      );

      if (cut) {
        expect(result.description).toBe(`${'x'.repeat(4000)}…`);
        expect(result.descriptionTruncated).toBe(true);
        expect(result.descriptionLength).toBe(4001);
      } else {
        expect(result.description).toBe(description);
        expect(result).not.toHaveProperty('descriptionTruncated');
        expect(result).not.toHaveProperty('descriptionLength');
      }
    });

    it('leaves a short description and its rendering byte-identical to the uncapped call', async () => {
      const description = 'D'.repeat(1075);
      mockGetMetadata.mockResolvedValue({ ...sampleMetadata, description });
      const capped = await runToolContract(getDatasetSchema, { datasetId: 'x66v-w5ka' });
      const full = await runToolContract(getDatasetSchema, {
        datasetId: 'x66v-w5ka',
        full_description: true,
      });

      expect(capped.structuredContent).toEqual(full.structuredContent);
      expect(contentText(capped)).toBe(contentText(full));
      expect((capped.structuredContent as { description: string }).description).toBe(description);
    });

    it('never shortens a column description, capped or not', async () => {
      const columns = [{ fieldName: 'a', dataType: 'text', description: 'C'.repeat(9000) }];
      mockGetMetadata.mockResolvedValue({ ...longMetadata, columns });
      const capped = await runToolContract(getDatasetSchema, { datasetId: 'ua7e-t2fy' });
      const full = await runToolContract(getDatasetSchema, {
        datasetId: 'ua7e-t2fy',
        full_description: true,
      });

      const cols = (r: typeof capped) => (r.structuredContent as { columns: unknown }).columns;
      expect(cols(capped)).toEqual(columns);
      expect(cols(full)).toEqual(columns);
    });

    it('states the cap and the opt-in on the description, input, and tool surfaces', () => {
      expect(getDatasetSchema.output.shape.description.description).toBe(
        'Dataset description when provided, as plain text — markup stripped and entity references decoded. Capped at 4,000 characters by default and ending in "…" when cut, with descriptionTruncated and descriptionLength set; pass full_description: true for the whole text. Column descriptions are never shortened.',
      );
      expect(getDatasetSchema.input.shape.full_description.description).toContain('4,000');
      expect(getDatasetSchema.description).toContain('full_description: true');
      expect(getDatasetSchema.description).toContain('4,000');
    });
  });

  describe('format', () => {
    it('renders a markdown table of columns', () => {
      const blocks = getDatasetSchema.format!(sampleMetadata);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Diabetes Mortality');
      expect(text).toContain('50,000');
      expect(text).toContain('| `state` | text | US state name |');
      expect(text).toContain('| `year` | number | Data year |');
      expect(text).toContain('| `deaths` | number | Number of deaths |');
    });

    it('renders dash for missing column description', () => {
      const meta = {
        ...sampleMetadata,
        columns: [{ fieldName: 'mystery', dataType: 'text', description: '' }],
      };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| `mystery` | text | — |');
    });
  });

  describe('content[] Markdown rendering', () => {
    const rendered = (meta: DatasetMetadata) =>
      renderMarkdown((getDatasetSchema.format!(meta)[0] as { type: 'text'; text: string }).text);

    it('renders each field name as a code span that reads back as the field name', () => {
      const html = rendered({
        ...sampleMetadata,
        columns: [{ fieldName: 'data_value_type', dataType: 'text', description: 'Type' }],
      });
      expect(renderedCells(html)[0]).toBe('<code>data_value_type</code>');
    });

    it('renders the name, description, types, and column descriptions as literal text', () => {
      const meta: DatasetMetadata = {
        name: '**Cases** <i>by</i> week #',
        description: '# 2000. [x](https://e.com) *y* _z_',
        columns: [
          {
            fieldName: 'a|b',
            dataType: '<b>text</b>',
            description: 'Rate *per* 100k\n\n# heading | pipe',
          },
        ],
      };
      const html = rendered(meta);

      expect(
        strayElements(html, [
          'h2',
          'p',
          'strong',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
          'code',
        ]),
      ).toEqual([]);
      expect(readBack(html.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? '')).toBe(meta.name);
      expect(readBack(html.match(/<\/h2>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? '')).toBe(meta.description);
      expect(renderedCells(html).map(readBack)).toEqual([
        'a|b',
        '<b>text</b>',
        'Rate *per* 100k # heading | pipe',
      ]);
    });

    it('links a URL in the description and a column description to the address it spells', () => {
      /** From `p56q-jrxg`: `-_` is not intraword, so an escape there would land in the link. */
      const url = 'https://www.cdc.gov/nchs/nvss/bridged_race/county_geography-_changes2015.pdf';
      const meta: DatasetMetadata = {
        name: 'Bridged-race population',
        description: `Available from: ${url}.`,
        columns: [{ fieldName: 'fips', dataType: 'text', description: `See ${url}` }],
      };
      const html = rendered(meta);

      expect(html.match(/href="[^"]*"/g)).toEqual([`href="${url}"`, `href="${url}"`]);
      expect(readBack(html.match(/<\/h2>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? '')).toBe(meta.description);
      expect(renderedCells(html).map(readBack)).toEqual(['fips', 'text', `See ${url}`]);
    });

    it('renders the column-window notice as a blockquote', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'Wide',
        columns: Array.from({ length: 3 }, (_, i) => ({ fieldName: `c${i}`, dataType: 'text' })),
      });
      const result = await runToolContract(getDatasetSchema, {
        datasetId: 'ab12-cd34',
        column_limit: 1,
      });

      const html = renderMarkdown(contentText(result));
      const quote = html.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1] ?? '';
      expect(readBack(quote)).toContain('Showing columns 1–1 of 3.');
    });
  });
});
