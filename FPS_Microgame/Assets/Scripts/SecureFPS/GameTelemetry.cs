using UnityEngine;
using System.Globalization;

public class GameTelemetry : MonoBehaviour
{
    public static GameTelemetry Instance;

    private bool gameStarted = false;
    private bool gameCompleted = false;

    private void Awake()
    {
        if (Instance == null)
        {
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }
        else
        {
            Destroy(gameObject);
        }
    }

    private void Start()
    {
        Debug.Log("[SecureFPS TEST] GameTelemetry START");

        StartGame();
    }

    // =========================================================
    // GAME START
    // =========================================================

    public void StartGame()
    {
        if (gameStarted)
        {
            return;
        }

        gameStarted = true;

        SendEvent(
            "game_started",
            "{}"
        );
    }

    // =========================================================
    // GENERIC EVENT
    // =========================================================

    public void SendEvent(
        string eventType,
        string telemetryJson = "{}"
    )
    {
        if (SecureFPSClient.Instance == null)
        {
            Debug.LogError(
                "[SecureFPS] SecureFPSClient is not present."
            );

            return;
        }

        SecureFPSClient.Instance.SendEvent(
            eventType,
            telemetryJson
        );
    }

    // =========================================================
    // WEAPON FIRE
    // =========================================================

    public void WeaponFire(string weaponName)
    {
        string json =
            "{"
            + "\"weapon\":\""
            + EscapeJson(weaponName)
            + "\""
            + "}";

        SendEvent(
            "weapon_fire",
            json
        );
    }

    // =========================================================
    // PLAYER HIT
    // =========================================================

    public void PlayerHit(float damage)
    {
        string json =
            "{"
            + "\"damage\":"
            + damage.ToString(
                CultureInfo.InvariantCulture
            )
            + "}";

        SendEvent(
            "player_hit",
            json
        );
    }

    // =========================================================
    // ENEMY KILLED
    // =========================================================

    public void EnemyKilled(string enemyName)
    {
        string json =
            "{"
            + "\"enemy\":\""
            + EscapeJson(enemyName)
            + "\""
            + "}";

        SendEvent(
            "enemy_killed",
            json
        );
    }

    // =========================================================
    // HEADSHOT
    // =========================================================

    public void Headshot(string enemyName = "")
    {
        string json =
            "{"
            + "\"enemy\":\""
            + EscapeJson(enemyName)
            + "\""
            + "}";

        SendEvent(
            "headshot",
            json
        );
    }

    // =========================================================
    // PLAYER DEATH
    // =========================================================

    public void PlayerDeath()
    {
        SendEvent(
            "player_death",
            "{}"
        );
    }

    // =========================================================
    // GAME COMPLETED
    // =========================================================

    public void GameCompleted()
    {
        if (gameCompleted)
        {
            return;
        }

        gameCompleted = true;

        SendEvent(
            "game_completed",
            "{}"
        );
    }

    // =========================================================
    // PLAYER BEHAVIOR
    // =========================================================

    public void PlayerBehavior(
        float speed,
        float x,
        float y,
        float z,
        bool grounded
    )
    {
        string json =
            "{"
            + "\"speed\":"
            + speed.ToString(
                CultureInfo.InvariantCulture
            )
            + ","
            + "\"position\":{"
            + "\"x\":"
            + x.ToString(
                CultureInfo.InvariantCulture
            )
            + ","
            + "\"y\":"
            + y.ToString(
                CultureInfo.InvariantCulture
            )
            + ","
            + "\"z\":"
            + z.ToString(
                CultureInfo.InvariantCulture
            )
            + "},"
            + "\"grounded\":"
            + grounded.ToString().ToLower()
            + "}";

        SendEvent(
            "player_behavior",
            json
        );
    }

    // =========================================================
    // AIM BEHAVIOR
    // =========================================================

    public void AimBehavior(
        float rotationChange
    )
    {
        string json =
            "{"
            + "\"rotation_change\":"
            + rotationChange.ToString(
                CultureInfo.InvariantCulture
            )
            + "}";

        SendEvent(
            "aim_behavior",
            json
        );
    }

    // =========================================================
    // JSON ESCAPE
    // =========================================================

    private string EscapeJson(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "";
        }

        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"");
    }
}