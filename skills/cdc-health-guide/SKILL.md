---
name: cdc-health-guide
description: Gates for comparing, ranking, and trending cdc_* results — which CDC WONDER rate to compare, race beside Hispanic origin, the provisional database's partial year and withheld causes, finding a peak month, splicing WONDER databases, ranking or comparing a staged WONDER table, reading stratified Socrata tables, and reaching a file entry. Use before saying a CDC mortality or health figure rose, fell, peaks, or differs between groups or places.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

CDC public health data, keyless. cdc_query_wonder pins every request to the whole United States, so state and county death figures can only come from a Socrata table found with cdc_discover_datasets. Name the system behind every figure, and for WONDER the database.

## Gates

**Compare groups on `age_adjusted_rate`.** `crude_rate` moves with each group's age mix: it measures the burden a group bears, while the age-adjusted rate compares the risk of dying at the same age. In the provisional database's 2025 rows (as of October 2026), Hispanic deaths run 389.2 per 100,000 crude against 1,036.3 for non-Hispanic (2.7 times), but 543.6 against 746.2 age-adjusted (1.4 times). Compare groups on the age-adjusted rate and its interval. It is left out when `group_by` holds `age_group` or `age_groups` names a single group; compare crude rates within one age group then. Deaths of unknown age count in `deaths` and `crude_rate` but not in the age-adjusted rate.

**Race and Hispanic origin overlap.** Each splits all deaths on its own: the four bridged race groups of 2019 sum to that year's 2,854,838 deaths, and the three Hispanic-origin rows of 2025 sum to that year's 3,096,843. A Hispanic decedent also sits in a race row, so a "Black or African American" row beside a "Hispanic or Latino" row compares populations that share people. For non-Hispanic race groups, group by both `race` and `hispanic_origin`. "Not Stated" origin deaths are in neither origin group and carry no population or rate.

**Never compare the provisional latest year by its total.** Its deaths stop at the data-through date while its population is the full-year estimate. Through October 17, 2026, the provisional database held 2,373,108 deaths for 2026 against 3,096,843 for 2025, at the same population of 340,110,988: a crude rate of 697.7 against 910.5. Compare the current year with an earlier one month by month, over months both years cover in full. Drop the month the data-through date falls in: October 2026 held 105,025 deaths through the 17th, against 234,461 in September.

**Withheld causes end the comparison earlier.** On the provisional database CDC counts external-cause (V01–Y89, every overdose code among them) and sudden-death (R95, R96) deaths from the 24 weeks before the data-through date under `"999--999"` until it releases their cause; on `mcd_icd10` drug poisoning (T36–T50) is withheld too. A filter or cause grouping that reaches those codes undercounts every period after the cutoff date the notice names: 2026 overdose deaths read 20,062 through October 17 against 69,391 for 2025, the partial year and the withheld weeks together. End a trend or month comparison of those causes at the last month before the cutoff. The `"999--999"` count spans all of those causes at once (96,700 deaths in 2026), so it bounds what one cause's series is missing. Never add it to that series.

**`month` is a year-month.** Grouping by `month` returns one row per month of each year ("Jan., 2019"), with deaths only. For the month a cause peaks in, use several full years: add up each calendar month across them, or read each year's peak. Months differ in length, so compare deaths per day. January 2019's 257,649 deaths are 8,311 a day and February's 232,821 are 8,315: February runs higher per day, which the raw counts reverse.

**Take both sides of a comparison from one database.** A gap between two databases lands in the difference being reported. `provisional` holds 2018 through the current year, so one call carries 2023 beside the latest year. A series from 1999 on joins `underlying_1999_2020` to `underlying_2018_2024` or `provisional`, which share 2018–2020: splice only once those years agree, and never splice a race breakdown.

**Rank, compare, or page a staged WONDER table with SQL, not with more WONDER calls.** Where `cdc_dataframe_query` is listed, a `cdc_query_wonder` call at offset 0 that leaves rows past its page stages the whole table and names it in `stagedTable`. Every further `cdc_query_wonder` page re-runs the query behind a 16-second gap; a SELECT over the staged table does not. A change since a base year, a ranking across causes, and a comparison of strata all need every row, so read them from the staged table. Staging happens only on a first page that leaves rows: a table that fits the page arrives whole inline and stages nothing, and a call at a later offset stages nothing either, so call again at offset 0. The table is dropped an hour after the last query that read it, or earlier, earliest-expiring first, once 200 are staged, and `cdc_dataframe_describe` lists what is staged; on a `missing_table` failure, check the name against that list, and call `cdc_query_wonder` again at offset 0 for a table that is gone.

**Filter or report the `<measure>_status` columns.** In a staged table a rate CDC flagged is null, and its `<measure>_status` column holds the token: `Unreliable`, `Suppressed`, or `Not Applicable`. A null sorts last in `ORDER BY` either direction, so a ranking quietly drops those rows to the bottom. Filter on the status column, or report the flagged rows beside the ranking, instead of reading a null as a low or missing rate. Dimension columns are text, so a year compares as `'2024'`, and `count(*)` comes back as a string.

**A file entry is downloaded, not queried.** `cdc_discover_datasets` gives a `file` entry a `downloadUrl`, and `cdc_get_dataset_schema` on a file fails `not_queryable` naming it. Fetch it with a GET request; it redirects to the file. `cdc_query_dataset` on a file returns `access_denied`.

**Enumerate a Socrata table's categories before reading a value.** Many CDC tables are long: each row is one location, period, question, and stratum, with the overall row stored beside its breakdowns. In hn4x-zwk7 the 2022 adult-obesity question alone fills 1,540 rows across six `stratificationcategory1` values (Total, Sex, Age (years), Education, Income, Race/Ethnicity), 55 of them Total rows, one per location. Run the grouped count that cdc_query_dataset's `select` describes on each categorical column first, then filter to one question, one value type, and the overall stratum. Summing or averaging a value across strata counts the same people more than once, and a percentage never sums. Locations mix too: those 55 rows are the 50 states, DC, Guam, Puerto Rico, the Virgin Islands, and a "US" row labelled "National". Drop the ones the question leaves out before ranking states.

**A Socrata row without a value is not a zero.** SODA leaves a null field out of the row instead of sending it, so a suppressed or unreported value arrives as a row with no such key. In that same question 156 of the 440 Race/Ethnicity rows carry no `data_value`, and their `data_value_footnote` reads "Data not available because sample size is insufficient or data not reported." Compare `count(<value column>)` with `count(*)` before averaging or ranking, and read the footnote column where the table has one.

## Workflows

**Is a cause of death still rising?** Query `provisional` with the cause filter and `group_by` `["year"]`, and trend `age_adjusted_rate` with its interval through the last finished year that ends before any withheld-cause cutoff the notice names. For the current year, group by `["month"]` over the last finished year and the current one, and compare per the two provisional gates. Report the finished years and the current-year months apart.

**Which month does a cause peak in?** Group by `["month"]` over several finished years, add up each calendar month, and divide by its days.

**Compare groups in one year.** Group by `["hispanic_origin"]`, or `["race", "hispanic_origin"]`, with `year_range` set to that year on a database that holds it (`underlying_2018_2024` for a settled 2018–2024 year), and compare the `age_adjusted_rate` intervals.
