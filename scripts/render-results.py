#!/usr/bin/env python3
"""Render validated benchmark results and copy the generated public files."""

import argparse
import csv
import hashlib
import html
import json
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parent.parent.parent
DEFAULT_PUBLIC = REPOSITORY_ROOT / "site" / "assets" / "benchmarks" / "playwright-puppeteer"


def number(value, digits=3):
    if value is None:
        return "n/a"
    formatted = f"{value:,.{digits}f}"
    if "." in formatted:
        return formatted.rstrip("0").rstrip(".")
    return formatted


def render(summary, fragment=False):
    methodology = summary["methodology"]
    environment = summary["environment"]
    sections = []
    for scenario in summary["scenarios"]:
        rows = []
        for result in scenario["libraries"]:
            failure_categories = result["failureCategories"]
            failures = str(result["failures"])
            if failure_categories:
                failures += f" ({html.escape(json.dumps(failure_categories, separators=(',', ':')))})"
            rows.append(f"""<tr>
<td>{html.escape(result['library'])}</td>
<td>{result['measuredRuns']}</td>
<td>{number(result['wallMs']['median'])}</td>
<td>{number(result['wallMs']['p95'])}</td>
<td>{number(result['workflowMs']['median'])}</td>
<td>{number(result['peakSampledRssKiB']['median'], 0)}</td>
<td>{failures}</td>
<td>{result['forcedCleanups']}</td>
</tr>""")
        batch_cells = []
        for result in scenario["libraries"]:
            counts = ", ".join(f"batch {batch['batch']}: {batch['runs']}" for batch in result["batches"])
            batch_cells.append(f"<li>{html.escape(result['library'])}: {html.escape(counts)}</li>")
        sections.append(f"""<section id="{html.escape(scenario['scenario'])}">
<h2>{html.escape(scenario['scenario'])}</h2>
<p>Concurrency {scenario['concurrency']}. Output SHA-256 <code>{html.escape(scenario['outputHash'] or 'n/a')}</code>.</p>
<ul>{''.join(batch_cells)}</ul>
<div class="table-scroll"><table class="benchmark-table">
<caption>{html.escape(scenario['scenario'])} results. Times are milliseconds; memory is KiB.</caption>
<thead><tr><th>Library</th><th>N</th><th>Wall median</th><th>Wall p95</th><th>Workflow median</th><th>Peak RSS median</th><th>Failures</th><th>Forced cleanup</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table></div>
</section>""")

    if fragment:
        return "".join(sections)

    versions = ", ".join(f"{html.escape(name)} {html.escape(version)}" for name, version in environment["libraryVersions"].items())
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playwright vs Puppeteer benchmark results</title>
<style>
:root {{ color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }}
body {{ margin: 0 auto; padding: 1rem; max-width: 110rem; }}
h1 {{ font-size: 1.8rem; }} h2 {{ margin-top: 2rem; font-size: 1.25rem; }}
code {{ overflow-wrap: anywhere; }} .notes {{ max-width: 75rem; }}
.table-scroll {{ overflow-x: auto; -webkit-overflow-scrolling: touch; }}
.benchmark-table {{ border-collapse: collapse; width: 100%; min-width: 52rem; font-variant-numeric: tabular-nums; }}
.benchmark-table th, .benchmark-table td {{ border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: .45rem .55rem; text-align: right; white-space: nowrap; }}
.benchmark-table th:first-child, .benchmark-table td:first-child, .benchmark-table th:last-child, .benchmark-table td:last-child {{ text-align: left; }}
.benchmark-table thead {{ background: color-mix(in srgb, currentColor 8%, transparent); }}
.benchmark-table caption {{ text-align: left; padding: .4rem 0; }}
@media (max-width: 48rem) {{ body {{ padding: .65rem; }} .benchmark-table {{ font-size: .85rem; }} }}
</style></head><body>
<h1>Playwright vs Puppeteer benchmark results</h1>
<div class="notes">
<p>Generated {html.escape(methodology['generatedAt'])}. Benchmark ID <code>{html.escape(methodology['benchmarkId'])}</code>.</p>
<p>{html.escape(versions)}; {html.escape(environment['nodeVersion'])}; {html.escape(environment['chromeVersion'])}; {html.escape(environment['osVersion'])}; {html.escape(environment['hardware'])}.</p>
<p>{methodology['measuredRecordCount']} measured records and {methodology['warmupRecordCount']} warmups. Each library and scenario has {methodology['iterationsPerLibraryScenarioBatch']} measured iterations in each of {len(methodology['batches'])} batches. Measured failures: {methodology['measuredFailures']}. Warmup failures: {methodology['warmupFailures']}. Forced cleanups: {methodology['measuredForcedCleanups']} measured and {methodology['warmupForcedCleanups']} warmup.</p>
<p>{html.escape(methodology['statisticsPopulation'])}</p>
<p>{html.escape(methodology['percentile'])}</p>
<p>{html.escape(methodology['memory'])} RSS counts resident pages, not unique physical memory. Shared pages can be counted in more than one process, so the sum can overstate memory. A 50 ms sampler can miss shorter spikes, and Chrome startup before root discovery is not fully sampled. The Node driver is reused across iterations while each browser is fresh.</p>
<p>{html.escape(methodology['cleanup'])}</p>
<p>Wall time includes the run-scoped fixture reset, process-monitor setup, browser launch, context/page creation, workflow, cleanup, and the process-exit check. It is absolute elapsed time, not a normalized score. Outliers remain in the data. Renderer recovery crashes one renderer through CDP Page.crash, not the whole browser.</p>
</div>
{''.join(sections)}
</body></html>
"""


def atomic_write(path, content):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def atomic_copy(source, destination):
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copyfile(source, temporary)
    temporary.replace(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results-dir", type=Path, default=PROJECT_ROOT / "results")
    parser.add_argument("--public-dir", type=Path, default=DEFAULT_PUBLIC)
    args = parser.parse_args()
    results = args.results_dir.resolve()
    public = args.public_dir.resolve()
    summary_path = results / "summary.json"
    csv_path = results / "summary.csv"
    raw_path = results / "raw.jsonl"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if summary["methodology"]["mode"] != "full":
        raise SystemExit("Rendering public outputs requires a validated full-run summary")
    digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    if digest != summary["methodology"]["rawSha256"]:
        raise SystemExit("raw.jsonl does not match the SHA-256 in summary.json")
    with csv_path.open(newline="", encoding="utf-8") as source:
        csv_rows = list(csv.DictReader(source))
    expected_keys = [(scenario["scenario"], library["library"]) for scenario in summary["scenarios"] for library in scenario["libraries"]]
    csv_keys = [(row["scenario"], row["library"]) for row in csv_rows]
    if csv_keys != expected_keys:
        raise SystemExit("summary.csv rows do not match summary.json")
    for row, scenario in zip(csv_rows, (scenario for scenario in summary["scenarios"] for _ in scenario["libraries"])):
        result = next(item for item in scenario["libraries"] if item["library"] == row["library"])
        expected_median = result["wallMs"]["median"]
        csv_median = "" if expected_median is None else str(expected_median)
        if int(row["measured_runs"]) != result["measuredRuns"] or row["wall_median_ms"] != csv_median:
            raise SystemExit(f"summary.csv does not match summary.json for {row['library']}/{row['scenario']}")

    rendered = render(summary)
    rendered_fragment = render(summary, fragment=True)
    public.mkdir(parents=True, exist_ok=True)
    atomic_write(results / "results-table.html", rendered)
    atomic_write(public / "results-table.html", rendered_fragment)
    for name in ("summary.csv", "summary.json", "raw.jsonl"):
        atomic_copy(results / name, public / name)
    print(results / "results-table.html")
    for name in ("results-table.html", "summary.csv", "summary.json", "raw.jsonl"):
        print(public / name)


if __name__ == "__main__":
    main()
