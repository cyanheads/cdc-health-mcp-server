/**
 * @fileoverview Tests for the WONDER request XML builder.
 * @module tests/services/wonder/xml-builder
 */

import { describe, expect, it } from 'vitest';
import { buildRequestXml, measuresFor } from '@/services/wonder/xml-builder.js';

/** Read a parameter's value(s) out of the built XML. */
function values(xml: string, name: string): string[] {
  const block = xml.match(new RegExp(`<parameter><name>${name}</name>(.*?)</parameter>`, 's'));
  if (!block) return [];
  return [...block[1].matchAll(/<value>(.*?)<\/value>/g)].map((m) => m[1] ?? '');
}

describe('measuresFor', () => {
  it('includes age-adjusted rate when age is not a grouping dimension', () => {
    expect(measuresFor(['year'])).toEqual([
      'deaths',
      'population',
      'crude_rate',
      'age_adjusted_rate',
    ]);
    expect(measuresFor(['year', 'sex', 'race'])).toContain('age_adjusted_rate');
  });

  it('omits age-adjusted rate when grouping by age (age is the standardization axis)', () => {
    expect(measuresFor(['age_group'])).toEqual(['deaths', 'population', 'crude_rate']);
    expect(measuresFor(['year', 'age_group'])).not.toContain('age_adjusted_rate');
  });
});

describe('buildRequestXml', () => {
  it('maps group-by dimensions to B_ slots in order and fills the rest with *None*', () => {
    const { xml, columns, dimensionCount } = buildRequestXml({ groupBy: ['year', 'sex'] });
    expect(values(xml, 'B_1')).toEqual(['D76.V1-level1']);
    expect(values(xml, 'B_2')).toEqual(['D76.V7']);
    expect(values(xml, 'B_3')).toEqual(['*None*']);
    expect(values(xml, 'B_5')).toEqual(['*None*']);
    expect(dimensionCount).toBe(2);
    expect(columns).toEqual([
      'year',
      'sex',
      'deaths',
      'population',
      'crude_rate',
      'age_adjusted_rate',
    ]);
  });

  it('requests M_1..M_4 with age-adjusted rate and aar_std when not grouping by age', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'] });
    expect(values(xml, 'M_1')).toEqual(['D76.M1']);
    expect(values(xml, 'M_4')).toEqual(['D76.M4']);
    expect(values(xml, 'O_aar')).toEqual(['aar_std']);
  });

  it('drops the age-adjusted measure and uses aar_none when grouping by age', () => {
    const { xml, columns } = buildRequestXml({ groupBy: ['age_group'] });
    expect(values(xml, 'B_1')).toEqual(['D76.V5']);
    expect(values(xml, 'M_4')).toEqual([]);
    expect(values(xml, 'O_aar')).toEqual(['aar_none']);
    expect(columns).not.toContain('age_adjusted_rate');
  });

  it('sets the cause finder from causeIcd10 and leaves it at *All* otherwise', () => {
    expect(values(buildRequestXml({ groupBy: ['year'] }).xml, 'F_D76.V2')).toEqual(['*All*']);
    const { xml } = buildRequestXml({ groupBy: ['year'], causeIcd10: 'C00-C97' });
    expect(values(xml, 'F_D76.V2')).toEqual(['C00-C97']);
    expect(values(xml, 'I_D76.V2')).toEqual(['C00-C97']);
  });

  it('maps sex filter to the D76.V7 value', () => {
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'female' }).xml, 'V_D76.V7')).toEqual([
      'F',
    ]);
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'male' }).xml, 'V_D76.V7')).toEqual([
      'M',
    ]);
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'all' }).xml, 'V_D76.V7')).toEqual([
      '*All*',
    ]);
  });

  it('lists selected age groups as multiple V_D76.V5 values', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'], ageGroups: ['25-34', '35-44'] });
    expect(values(xml, 'V_D76.V5')).toEqual(['25-34', '35-44']);
  });

  it('expands a year range across both the finder and value parameters', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'], yearRange: { from: 2018, to: 2020 } });
    expect(values(xml, 'F_D76.V1')).toEqual(['2018', '2019', '2020']);
    expect(values(xml, 'V_D76.V1')).toEqual(['2018', '2019', '2020']);
  });

  it('always pins location to national and never emits a location value', () => {
    const { xml } = buildRequestXml({
      groupBy: ['year', 'sex', 'race'],
      sex: 'male',
      causeIcd10: 'I00-I99',
    });
    expect(values(xml, 'F_D76.V9')).toEqual(['*All*']);
    expect(values(xml, 'V_D76.V9')).toEqual(['']); // present but empty — never a specific location
    expect(values(xml, 'I_D76.V9')).toEqual(['*All* (The United States)']);
  });

  it('always includes the data-use-restriction acknowledgement', () => {
    expect(
      values(buildRequestXml({ groupBy: ['year'] }).xml, 'accept_datause_restrictions'),
    ).toEqual(['true']);
  });
});
