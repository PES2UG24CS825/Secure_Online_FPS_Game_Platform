"""
SecureFPS Risk Scoring & Classification Service
Defines authoritative, configurable operational risk score bands (0-100),
boundary clamping, severity mappings, and review priority recommendations.
"""
from typing import Dict, Any, Optional

RISK_SCORE_SCALE = [
    {
        "min": 0.0,
        "max": 39.99,
        "category": "Normal",
        "action": "No security action required",
        "severity": "low",
        "meaning": "Verified human gameplay / no meaningful suspicious evidence"
    },
    {
        "min": 40.0,
        "max": 64.99,
        "category": "Monitoring",
        "action": "Retain telemetry and observe",
        "severity": "low",
        "meaning": "Unusual gameplay variation, retain telemetry and observe"
    },
    {
        "min": 65.0,
        "max": 79.99,
        "category": "Suspicious",
        "action": "Request admin investigation",
        "severity": "medium",
        "meaning": "Multiple indicators requiring investigation"
    },
    {
        "min": 80.0,
        "max": 89.99,
        "category": "High Risk",
        "action": "Priority admin review",
        "severity": "high",
        "meaning": "Strong indicators requiring priority review"
    },
    {
        "min": 90.0,
        "max": 100.0,
        "category": "Critical Risk",
        "action": "Urgent investigation",
        "severity": "critical",
        "meaning": "Very strong indicators requiring urgent review"
    }
]


def clamp_risk_score(score: Any) -> Optional[float]:
    """Clamps risk score strictly between 0.0 and 100.0."""
    if score is None:
        return None
    try:
        val = float(score)
        return max(0.0, min(100.0, round(val, 2)))
    except (ValueError, TypeError):
        return None


def classify_risk_score(score: Any) -> Dict[str, Any]:
    """
    Standard Operational Risk Classification (0-100).
    Maps numerical score to category, meaning, recommended review action, and severity.
    """
    clamped = clamp_risk_score(score)
    if clamped is None:
        return {
            "score": None,
            "category": "Analysis Incomplete",
            "meaning": "Telemetry missing or insufficient for ML classification",
            "action": "Inspect telemetry pipeline",
            "severity": "unknown"
        }

    for band in RISK_SCORE_SCALE:
        if band["min"] <= clamped <= band["max"] or (band["max"] == 100.0 and clamped >= 90.0):
            return {
                "score": clamped,
                "category": band["category"],
                "meaning": band["meaning"],
                "action": band["action"],
                "severity": band["severity"]
            }

    # Fallback bounds check
    if clamped < 40.0:
        return {
            "score": clamped,
            "category": "Normal",
            "meaning": "Verified human gameplay / no meaningful suspicious evidence",
            "action": "No security action required",
            "severity": "low"
        }
    return {
        "score": clamped,
        "category": "Critical Risk",
        "meaning": "Very strong indicators requiring urgent review",
        "action": "Urgent investigation",
        "severity": "critical"
    }
