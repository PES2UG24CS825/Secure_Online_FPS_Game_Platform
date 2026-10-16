import unittest

from models.ml_model import calculate_risk_score, normalize_isolation_decision


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


if __name__ == "__main__":
    unittest.main()
