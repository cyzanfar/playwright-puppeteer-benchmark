#!/usr/bin/env python3
"""Validate benchmark JSONL and calculate per-scenario statistics."""

import argparse
import csv
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LIBRARIES = ("playwright", "puppeteer")
SCENARIOS = {
    "basic": 1,
    "js": 1,
    "slow": 1,
    "session-create": 1,
    "session-reuse": 1,
    "failure-recovery": 1,
    "session-expiry-recovery": 1,
    "renderer-recovery": 1,
    "concurrency-1": 1,
    "concurrency-4": 4,
    "concurrency-8": 8,
    "concurrency-16": 16,
}
REQUIRED_FIELDS = {
    "runId", "benchmarkId", "library", "libraryVersion", "scenario", "batch",
    "iteration", "concurrency", "measured", "executionOrder", "nodeVersion",
    "chromeVersion", "osVersion", "hardware", "platform", "phases", "wallMs",
    "success", "outputHash", "failureCategory", "duplicates",
    "peakSampledRssKiB", "peakChromeSampledRssKiB", "peakNodeSampledRssKiB",
    "processAttribution", "timestamp", "error",
}
PHASES = (
    "launchMs", "contextMs", "pageMs", "workflowMs", "closeMs",
    "navigationMs", "waitMs", "extractionMs", "recoveryMs",
)


def fail(message):
    raise ValueError(message)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(values, probability):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def rounded(value):
    return None if value is None else round(value, 3)


def load_records(path):
    records = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                fail(f"Blank JSONL line at {line_number}")
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                fail(f"Invalid JSON at line {line_number}: {error}")
            if not isinstance(record, dict):
                fail(f"Line {line_number} is not a JSON object")
            record["_line"] = line_number
            records.append(record)
    if not records:
        fail("The input contains no runs")
    return records


def validate(records, iterations, batches, warmups):
    run_ids = set()
    execution_orders = set()
    benchmark_ids = set()
    expected_groups = Counter()
    actual_groups = Counter()
    hashes = {scenario: set() for scenario in SCENARIOS}
    environment_values = {field: set() for field in ("nodeVersion", "chromeVersion", "osVersion", "hardware", "platform")}
    library_versions = {library: set() for library in LIBRARIES}

    for scenario in SCENARIOS:
        for library in LIBRARIES:
            for batch in range(1, batches + 1):
                expected_groups[(library, scenario, True, batch)] = iterations
            if warmups:
                expected_groups[(library, scenario, False, 0)] = warmups

    for record in records:
        location = f"line {record['_line']}"
        missing = REQUIRED_FIELDS - record.keys()
        if missing:
            fail(f"{location}: missing fields {sorted(missing)}")
        for field in ("runId", "benchmarkId", "library", "libraryVersion", "scenario", "nodeVersion", "chromeVersion", "osVersion", "hardware", "platform"):
            if not isinstance(record[field], str) or not record[field]:
                fail(f"{location}: {field} must be a non-empty string")
        library = record["library"]
        scenario = record["scenario"]
        if library not in LIBRARIES:
            fail(f"{location}: unknown library {library}")
        if scenario not in SCENARIOS:
            fail(f"{location}: unknown scenario {scenario}")
        if record["concurrency"] != SCENARIOS[scenario] or isinstance(record["concurrency"], bool):
            fail(f"{location}: incorrect concurrency for {scenario}")
        if not isinstance(record["measured"], bool) or not isinstance(record["success"], bool):
            fail(f"{location}: measured and success must be booleans")
        batch = record["batch"]
        iteration = record["iteration"]
        order = record["executionOrder"]
        if isinstance(batch, bool) or not isinstance(batch, int):
            fail(f"{location}: batch must be an integer")
        if isinstance(iteration, bool) or not isinstance(iteration, int) or iteration < 1:
            fail(f"{location}: iteration must be a positive integer")
        if isinstance(order, bool) or not isinstance(order, int) or order < 1:
            fail(f"{location}: executionOrder must be a positive integer")
        if record["measured"]:
            if not 1 <= batch <= batches or iteration > iterations:
                fail(f"{location}: measured run is outside the requested batch/iteration range")
        elif batch != 0 or iteration > warmups:
            fail(f"{location}: warmup run is outside batch 0 or the warmup range")
        key = (library, scenario, record["measured"], batch)
        if key not in expected_groups:
            fail(f"{location}: unexpected library/scenario/batch group {key}")
        actual_groups[key] += 1
        if record["runId"] in run_ids:
            fail(f"{location}: duplicate runId {record['runId']}")
        run_ids.add(record["runId"])
        if order in execution_orders:
            fail(f"{location}: duplicate executionOrder {order}")
        execution_orders.add(order)
        benchmark_ids.add(record["benchmarkId"])
        for field in environment_values:
            environment_values[field].add(record[field])
        library_versions[library].add(record["libraryVersion"])
        if not is_number(record["wallMs"]) or record["wallMs"] <= 0:
            fail(f"{location}: wallMs must be positive")
        if not isinstance(record["phases"], dict) or set(PHASES) - record["phases"].keys():
            fail(f"{location}: phase fields are incomplete")
        for phase in PHASES:
            value = record["phases"][phase]
            if value is not None and (not is_number(value) or value < 0):
                fail(f"{location}: invalid {phase}")
            if record["success"] and not is_number(value):
                fail(f"{location}: successful run has no numeric {phase}")
        for field in ("peakSampledRssKiB", "peakChromeSampledRssKiB", "peakNodeSampledRssKiB"):
            if not is_number(record[field]) or record[field] < 0:
                fail(f"{location}: invalid {field}")
            if record["success"] and record[field] <= 0:
                fail(f"{location}: successful run has zero {field}")
        if not isinstance(record["duplicates"], int) or isinstance(record["duplicates"], bool) or record["duplicates"] < 0:
            fail(f"{location}: duplicates must be a nonnegative integer")
        if record["success"] and record["duplicates"] != 0:
            fail(f"{location}: successful run reports duplicates")
        output_hash = record["outputHash"]
        if output_hash is not None and (not isinstance(output_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", output_hash)):
            fail(f"{location}: malformed outputHash")
        if record["success"]:
            if output_hash is None:
                fail(f"{location}: successful run has no outputHash")
            hashes[scenario].add(output_hash)
            if record["error"] is not None or record["failureCategory"] is not None:
                fail(f"{location}: successful run contains failure details")
            attribution = record["processAttribution"]
            if not isinstance(attribution, dict) or attribution.get("attributionOk") is not True:
                fail(f"{location}: successful run has invalid process attribution")
            if attribution.get("rootProcessCount") != 1 or attribution.get("chromeSampleCount", 0) < 1:
                fail(f"{location}: successful run has incomplete Chrome attribution")
            if attribution.get("unrelatedChromePidsTracked") or attribution.get("leftoverHarnessPids") or attribution.get("sampleErrors"):
                fail(f"{location}: successful run has process attribution errors")
        else:
            if not isinstance(record["error"], str) or not record["error"]:
                fail(f"{location}: failed run needs an error")
            if not isinstance(record["failureCategory"], str) or not record["failureCategory"]:
                fail(f"{location}: failed run needs a failureCategory")
        try:
            datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00"))
        except (TypeError, ValueError) as error:
            fail(f"{location}: invalid timestamp: {error}")

    if actual_groups != expected_groups:
        problems = []
        for key in sorted(set(expected_groups) | set(actual_groups)):
            if actual_groups[key] != expected_groups[key]:
                problems.append(f"{key}: expected {expected_groups[key]}, got {actual_groups[key]}")
        fail("Incomplete or extra run groups: " + "; ".join(problems))
    if execution_orders != set(range(1, len(records) + 1)):
        fail("executionOrder values must be unique and contiguous from 1")
    if len(benchmark_ids) != 1:
        fail("The input mixes benchmark IDs")
    for field, values in environment_values.items():
        if len(values) != 1:
            fail(f"Inconsistent {field}: {sorted(values)}")
    for library, values in library_versions.items():
        if len(values) != 1:
            fail(f"Inconsistent library version for {library}: {sorted(values)}")
    for scenario, values in hashes.items():
        if len(values) > 1:
            fail(f"Inconsistent output hashes for {scenario}: {sorted(values)}")

    return {
        "benchmarkId": next(iter(benchmark_ids)),
        "environment": {field: next(iter(values)) for field, values in environment_values.items()},
        "libraryVersions": {library: next(iter(values)) for library, values in library_versions.items()},
        "outputHashes": {scenario: next(iter(values)) if values else None for scenario, values in hashes.items()},
    }


def stats_for(records, batches):
    measured = [record for record in records if record["measured"]]
    successful = [record for record in measured if record["success"]]

    def values(field):
        return [record[field] for record in successful]

    def phase_values(field):
        return [record["phases"][field] for record in successful]

    failure_categories = Counter(record["failureCategory"] for record in measured if not record["success"])
    batch_stats = []
    for batch in range(1, batches + 1):
        batch_records = [record for record in measured if record["batch"] == batch]
        batch_successful = [record for record in batch_records if record["success"]]
        batch_stats.append({
            "batch": batch,
            "runs": len(batch_records),
            "successfulRuns": len(batch_successful),
            "failures": len(batch_records) - len(batch_successful),
            "wallMedianMs": rounded(percentile([record["wallMs"] for record in batch_successful], 0.5)),
            "wallP95Ms": rounded(percentile([record["wallMs"] for record in batch_successful], 0.95)),
        })

    def distribution(field, source=values):
        data = source(field)
        return {
            "median": rounded(percentile(data, 0.5)),
            "p95": rounded(percentile(data, 0.95)),
            "min": rounded(min(data)) if data else None,
            "max": rounded(max(data)) if data else None,
        }

    return {
        "measuredRuns": len(measured),
        "successfulRuns": len(successful),
        "failures": len(measured) - len(successful),
        "duplicates": sum(record["duplicates"] for record in measured),
        "forcedCleanups": sum(record.get("details", {}).get("browserCloseForced") is True for record in measured),
        "failureCategories": dict(sorted(failure_categories.items())),
        "wallMs": distribution("wallMs"),
        "launchMs": distribution("launchMs", phase_values),
        "contextMs": distribution("contextMs", phase_values),
        "pageMs": distribution("pageMs", phase_values),
        "workflowMs": distribution("workflowMs", phase_values),
        "navigationMs": distribution("navigationMs", phase_values),
        "waitMs": distribution("waitMs", phase_values),
        "extractionMs": distribution("extractionMs", phase_values),
        "closeMs": distribution("closeMs", phase_values),
        "peakSampledRssKiB": distribution("peakSampledRssKiB"),
        "peakChromeSampledRssKiB": distribution("peakChromeSampledRssKiB"),
        "peakNodeSampledRssKiB": distribution("peakNodeSampledRssKiB"),
        "batches": batch_stats,
    }


def write_outputs(records, validated, output_dir, input_path, mode, iterations, batches, warmups):
    scenarios = []
    for scenario, concurrency in SCENARIOS.items():
        scenario_records = [record for record in records if record["scenario"] == scenario]
        libraries = []
        for library in LIBRARIES:
            selected = [record for record in scenario_records if record["library"] == library]
            libraries.append({"library": library, "libraryVersion": validated["libraryVersions"][library], **stats_for(selected, batches)})
        scenarios.append({
            "scenario": scenario,
            "concurrency": concurrency,
            "outputHash": validated["outputHashes"][scenario],
            "libraries": libraries,
        })

    measured_records = [record for record in records if record["measured"]]
    warmup_records = [record for record in records if not record["measured"]]
    summary = {
        "methodology": {
            "mode": mode,
            "benchmarkId": validated["benchmarkId"],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceRaw": input_path.name,
            "rawSha256": hashlib.sha256(input_path.read_bytes()).hexdigest(),
            "rawRecordCount": len(records),
            "measuredRecordCount": len(measured_records),
            "warmupRecordCount": len(warmup_records),
            "measuredFailures": sum(not record["success"] for record in measured_records),
            "warmupFailures": sum(not record["success"] for record in warmup_records),
            "measuredForcedCleanups": sum(record.get("details", {}).get("browserCloseForced") is True for record in measured_records),
            "warmupForcedCleanups": sum(record.get("details", {}).get("browserCloseForced") is True for record in warmup_records),
            "iterationsPerLibraryScenarioBatch": iterations,
            "batches": list(range(1, batches + 1)),
            "warmupsPerLibraryScenario": warmups,
            "percentile": "Sorted values; rank=(n-1)*p; linear interpolation between floor(rank) and ceil(rank). Median uses p=0.5 and p95 uses p=0.95.",
            "statisticsPopulation": "Successful measured runs only. Failed runs and warmups remain in raw.jsonl and failure counts, but not timing or memory percentiles.",
            "memory": "KiB. Each iteration schedules aggregate RSS sampling every 50 ms for the Node driver and attributed Chrome tree, then takes the peak. Statistics summarize those per-iteration peaks.",
            "cleanup": "browser.close() has 250 ms to finish. If the owned Chrome tree stalls it, the runner allows 100 ms for orphaned helpers, then signals only owned Chrome processes. SIGTERM has 250 ms before SIGKILL. Forced cleanup counts are reported.",
        },
        "environment": {
            **validated["environment"],
            "libraryVersions": validated["libraryVersions"],
        },
        "scenarios": scenarios,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "summary.json"
    csv_path = output_dir / "summary.csv"
    json_path.write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    columns = [
        "scenario", "library", "library_version", "concurrency", "measured_runs",
        "successful_runs", "failures", "duplicates", "forced_cleanups", "failure_categories",
        "wall_median_ms", "wall_p95_ms", "wall_min_ms", "wall_max_ms",
        "launch_median_ms", "launch_p95_ms", "context_median_ms", "page_median_ms",
        "workflow_median_ms", "workflow_p95_ms", "navigation_median_ms",
        "wait_median_ms", "extraction_median_ms", "close_median_ms",
        "peak_rss_median_kib", "peak_rss_p95_kib", "peak_rss_max_kib",
        "peak_chrome_rss_median_kib", "peak_chrome_rss_p95_kib",
        "peak_node_rss_median_kib", "peak_node_rss_p95_kib",
        *(f"batch_{batch}_runs" for batch in range(1, batches + 1)),
        "output_hash",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        for scenario in scenarios:
            for library in scenario["libraries"]:
                row = {
                    "scenario": scenario["scenario"],
                    "library": library["library"],
                    "library_version": library["libraryVersion"],
                    "concurrency": scenario["concurrency"],
                    "measured_runs": library["measuredRuns"],
                    "successful_runs": library["successfulRuns"],
                    "failures": library["failures"],
                    "duplicates": library["duplicates"],
                    "forced_cleanups": library["forcedCleanups"],
                    "failure_categories": json.dumps(library["failureCategories"], separators=(",", ":")),
                    "wall_median_ms": library["wallMs"]["median"],
                    "wall_p95_ms": library["wallMs"]["p95"],
                    "wall_min_ms": library["wallMs"]["min"],
                    "wall_max_ms": library["wallMs"]["max"],
                    "launch_median_ms": library["launchMs"]["median"],
                    "launch_p95_ms": library["launchMs"]["p95"],
                    "context_median_ms": library["contextMs"]["median"],
                    "page_median_ms": library["pageMs"]["median"],
                    "workflow_median_ms": library["workflowMs"]["median"],
                    "workflow_p95_ms": library["workflowMs"]["p95"],
                    "navigation_median_ms": library["navigationMs"]["median"],
                    "wait_median_ms": library["waitMs"]["median"],
                    "extraction_median_ms": library["extractionMs"]["median"],
                    "close_median_ms": library["closeMs"]["median"],
                    "peak_rss_median_kib": library["peakSampledRssKiB"]["median"],
                    "peak_rss_p95_kib": library["peakSampledRssKiB"]["p95"],
                    "peak_rss_max_kib": library["peakSampledRssKiB"]["max"],
                    "peak_chrome_rss_median_kib": library["peakChromeSampledRssKiB"]["median"],
                    "peak_chrome_rss_p95_kib": library["peakChromeSampledRssKiB"]["p95"],
                    "peak_node_rss_median_kib": library["peakNodeSampledRssKiB"]["median"],
                    "peak_node_rss_p95_kib": library["peakNodeSampledRssKiB"]["p95"],
                    "output_hash": scenario["outputHash"],
                }
                for batch in library["batches"]:
                    row[f"batch_{batch['batch']}_runs"] = batch["runs"]
                writer.writerow(row)
    return json_path, csv_path, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=PROJECT_ROOT / "results" / "raw.jsonl")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--pilot", action="store_true", help="Validate pilot defaults instead of the frozen full run")
    parser.add_argument("--iterations", type=int)
    parser.add_argument("--batches", type=int)
    parser.add_argument("--warmups", type=int)
    args = parser.parse_args()
    if not args.pilot and any(value is not None for value in (args.iterations, args.batches, args.warmups)):
        parser.error("Size overrides are allowed only with --pilot")
    iterations = args.iterations if args.iterations is not None else (5 if args.pilot else 50)
    batches = args.batches if args.batches is not None else (1 if args.pilot else 3)
    warmups = args.warmups if args.warmups is not None else (1 if args.pilot else 10)
    if iterations < 1 or batches < 1 or warmups < 0:
        parser.error("Iterations and batches must be positive; warmups cannot be negative")
    input_path = args.input.resolve()
    output_dir = (args.output_dir.resolve() if args.output_dir else input_path.parent)
    records = load_records(input_path)
    validated = validate(records, iterations, batches, warmups)
    json_path, csv_path, summary = write_outputs(records, validated, output_dir, input_path, "pilot" if args.pilot else "full", iterations, batches, warmups)
    print(f"Validated {len(records)} records: {summary['methodology']['measuredRecordCount']} measured and {summary['methodology']['warmupRecordCount']} warmups")
    print(f"Measured failures: {summary['methodology']['measuredFailures']}; warmup failures: {summary['methodology']['warmupFailures']}")
    print(json_path)
    print(csv_path)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(f"Analysis rejected the data: {error}") from error
