import unittest

from models.ml_model import calculate_risk_score, normalize_isolation_decision
from services.anti_cheat_intelligence import AntiCheatIntelligence


class ModelScoringTests(unittest.TestCase):
    def test_same_model_outputs_are_deterministic(self):
        first = calculate_risk_score(0.42, 0.18)
        second = calculate_risk_score(0.42, 0.18)
        self.assertEqual(first, second)

    def test_different_model_outputs_produce_different_scores(self):
        self.assertNotEqual(
            calculate_risk_score(0.42, 0.18),
            calculate_risk_score(0.43, 0.18),
        )

    def test_isolation_decision_is_normalized(self):
        self.assertGreater(normalize_isolation_decision(-1), normalize_isolation_decision(1))
        self.assertGreaterEqual(normalize_isolation_decision(0), 0)
        self.assertLessEqual(normalize_isolation_decision(0), 1)

    def test_rf_if_only_variation_is_capped_at_normal(self):
        human_eval = {
            "review_category": "Normal",
            "hard_cheat_evidence": [],
            "is_skilled_human": True,
        }
        score, severity = AntiCheatIntelligence.calibrate_ensemble_risk(
            "cheater", 0.8, "anomaly", 0.7, human_eval, {}
        )
        self.assertLessEqual(score, 39.0)
        self.assertEqual(severity, "low")

    def test_bot_match_does_not_treat_four_aim_snaps_as_hard_evidence(self):
        audit = {
            "counts": {"shots": 40, "hits": 8, "kills": 21, "deaths": 34, "headshots": 0},
            "features": {"accuracy": 0.1932, "movement_speed": 0.67, "aim_smoothness": 0.8058, "kdr": 0.6176},
            "physical_violations": {
                "speed_violations": [],
                "aim_snap_violations": [{"rotation_delta": 3.2}] * 4,
                "fire_rate_violations": [],
            },
            "has_combat": True,
        }
        result = AntiCheatIntelligence.evaluate_human_skill_context(
            audit["features"], audit, game_mode="bots"
        )
        self.assertEqual(result["hard_cheat_evidence"], [])


if __name__ == "__main__":
    unittest.main()
