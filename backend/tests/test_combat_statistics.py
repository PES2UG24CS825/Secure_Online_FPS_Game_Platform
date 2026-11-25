from services.combat_statistics import resolve_match_combat_stats, summarize_combat_stats


def test_missing_is_distinct_from_zero_and_zero_deaths_follow_kd_convention():
    empty = resolve_match_combat_stats({}, [])
    assert all(empty[key] is None for key in ("kills", "deaths", "shots_fired", "shots_hit", "headshots"))
    recorded = resolve_match_combat_stats({"kills": 3, "deaths": 0, "shots": 0, "hits": 0}, [])
    assert recorded["kdr"] == 3
    assert recorded["shots_fired"] == recorded["shots_hit"] == 0
    assert recorded["accuracy"] is None


def test_lifetime_ratios_use_paired_records():
    totals, _ = summarize_combat_stats([
        {"shots": 10, "hits": 5, "headshots": 2, "kills": 4, "deaths": 2},
        {"shots": 100, "kills": 99},
        {"hits": 90, "deaths": 6},
    ], {})
    assert totals["shots_fired"] == 110
    assert totals["shots_hit"] == 95
    assert totals["shots_hit_coverage"] == "partial"
    assert totals["accuracy"] == 50
    assert totals["headshot_percentage"] == 40
    assert totals["kdr"] == 2


def test_duplicate_events_and_authoritative_summary():
    shot = {"event_type": "weapon_fire", "telemetry": {"shot_id": "one"}}
    hit = {"event_type": "enemy_hit", "telemetry": {"shot_id": "one"}}
    events = [shot, shot, hit, hit]
    fallback = resolve_match_combat_stats({}, events)
    assert fallback["shots_fired"] == fallback["shots_hit"] == 1
    verified = resolve_match_combat_stats({"stats_source": "multiplayer_server", "shots": 0}, events)
    assert verified["shots_fired"] == 0
    assert verified["shots_hit"] is None


def test_invalid_combat_relationships_are_unavailable():
    invalid = resolve_match_combat_stats({"shots": 1, "hits": 2, "kills": -1}, [])
    assert invalid["accuracy"] is None
    assert invalid["shots_hit"] is None
    assert invalid["kills"] is None
    assert resolve_match_combat_stats({"hits": 1, "headshots": 2}, [])["headshots"] is None


def test_headshot_percentage_and_derived_shot_counts():
    m1 = resolve_match_combat_stats({"shots": 100, "hits": 51, "headshots": 41, "kills": 10, "deaths": 2}, [])
    assert m1["headshot_percentage"] == 80.4
    assert m1["non_headshot_hits"] == 10
    assert m1["missed_shots"] == 49
    assert m1["accuracy"] == 51.0

    m2 = resolve_match_combat_stats({"shots": 80, "hits": 45, "headshots": 35, "kills": 8, "deaths": 4}, [])
    assert m2["headshot_percentage"] == 77.8
    assert m2["non_headshot_hits"] == 10
    assert m2["missed_shots"] == 35
