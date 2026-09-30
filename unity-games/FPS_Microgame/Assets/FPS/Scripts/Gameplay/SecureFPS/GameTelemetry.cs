
using UnityEngine;
using System.Globalization;
using System.Collections;
using Unity.FPS.Game;

public class GameTelemetry : MonoBehaviour
{
    public static GameTelemetry Instance;
    private static bool gameStartedSent;

    private bool gameStarted = false;
    private bool gameCompleted = false;
    private bool playerDeathSent = false;
    private float sessionStartTime;
    private bool completionRequested = false;
    private bool demoTelemetryStarted = false;
    private Coroutine demoTelemetryRoutine;

    private SecureFPSClient secureClient;

    // =========================================================
    // AWAKE
    // =========================================================

    private void Awake()
    {
        if (Instance == null)
        {
            Instance = this;
        }
        else if (Instance != this)
        {
            Destroy(gameObject);
            return;
        }

        EventManager.AddListener<AllObjectivesCompletedEvent>(OnAllObjectivesCompleted);
        EventManager.AddListener<PlayerDeathEvent>(OnPlayerDeath);

        // Find SecureFPSClient on the same GameObject.
        secureClient = GetComponent<SecureFPSClient>();

        if (secureClient != null)
        {
            Debug.Log(
                "[SecureFPS] SecureFPSClient found on same GameObject."
            );
        }
        else
        {
            Debug.LogWarning(
                "[SecureFPS] SecureFPSClient not on same GameObject. " +
                "Will search when sending events."
            );
        }
    }

    private void OnDestroy()
    {
        EventManager.RemoveListener<AllObjectivesCompletedEvent>(OnAllObjectivesCompleted);
        EventManager.RemoveListener<PlayerDeathEvent>(OnPlayerDeath);

        if (Instance == this)
        {
            Instance = null;
        }
    }

    private void OnAllObjectivesCompleted(AllObjectivesCompletedEvent evt)
    {
        GameCompleted();
    }

    private void OnPlayerDeath(PlayerDeathEvent evt)
    {
        PlayerDeath();
    }

    // =========================================================
    // START
    // =========================================================

    private void Start()
    {
        Debug.Log("[SecureFPS TEST] GameTelemetry START");
        StartGame();
    }

    public void StartDemoTelemetry()
    {
        if (demoTelemetryStarted)
            return;

        demoTelemetryStarted = true;
        demoTelemetryRoutine = StartCoroutine(DemoTelemetryPattern());
    }

    public void StopDemoTelemetry()
    {
        if (demoTelemetryRoutine != null)
        {
            StopCoroutine(demoTelemetryRoutine);
            demoTelemetryRoutine = null;
        }
    }

    private IEnumerator DemoTelemetryPattern()
    {
        // Development simulation only: emit existing events; never change gameplay or model outputs.
        for (int shotIndex = 0; shotIndex < 20; shotIndex++)
        {
            WeaponFire("demo-telemetry-fixture");
            if (shotIndex < 19)
                EnemyHit("demo-telemetry-target", 1f);

            PlayerBehavior(8f, 0f, 0f, 0f, true);
            AimBehavior((1f / 0.95f) - 1f);

            yield return new WaitForSecondsRealtime(0.04f);
        }

        for (int killIndex = 0; killIndex < 9; killIndex++)
        {
            EnemyKilled("demo-telemetry-fixture");
            yield return new WaitForSecondsRealtime(0.005f);
        }

        // Report a telemetry event only. Do not invoke PlayerDeath(), which ends gameplay.
        SendEvent("player_death", "{}");
        demoTelemetryRoutine = null;
    }

    // =========================================================
    // GAME START
    // =========================================================

    public void StartGame()
    {
        if (gameStarted || gameStartedSent)
        {
            return;
        }

        gameStarted = true;
        gameStartedSent = true;
        sessionStartTime = Time.realtimeSinceStartup;


        SendEvent("game_started", "{}");
    }

    // =========================================================
    // GENERIC EVENT
    // =========================================================

    public void SendEvent(
        string eventType,
        string telemetryJson = "{}"
    )
    {
        Debug.Log(
            "[SecureFPS TEST] Sending telemetry event: " +
            eventType
        );

        // First: use the cached component.
        if (secureClient == null)
        {
            secureClient = GetComponent<SecureFPSClient>();
        }

        // Second: use the singleton.
        if (secureClient == null)
        {
            secureClient = SecureFPSClient.Instance;
        }

        // Third: search the scene for an existing client.
        if (secureClient == null)
        {
            Debug.LogWarning(
                "[SecureFPS TEST] Client reference is NULL. " +
                "Searching scene..."
            );

            secureClient = FindObjectOfType<SecureFPSClient>();
        }

        if (secureClient == null)
        {
            Debug.LogError(
                "[SecureFPS] No SecureFPSClient found. " +
                "Event not sent: " + eventType
            );

            return;
        }

        secureClient.SendEvent(
            eventType,
            telemetryJson
        );
    }

    public void EnemySpawned(string enemyId)
    {
        string json =
            "{"
            + "\"enemy_id\":\"" + EscapeJson(enemyId) + "\","
            + "\"timestamp\":"
            + Time.realtimeSinceStartup.ToString(
            CultureInfo.InvariantCulture)
            + "}";

        SendEvent("enemy_spawned", json);
    }



    // =========================================================
    // WEAPON FIRE
    // =========================================================

    public void WeaponFire(string weaponName)
    {
        Debug.Log(
            "[SecureFPS TEST] WEAPON FIRE DETECTED: " +
            weaponName
        );

        string json =
            "{"
            + "\"weapon\":\""
            + EscapeJson(weaponName)
            + "\","
            + "\"timestamp\":"
            + Time.realtimeSinceStartup.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent(
            "weapon_fire",
            json
        );
    }

    // =========================================================
    // PLAYER HIT
    // =========================================================

    public void EnemyHit(string targetId, float damage)
    {
        string json =
            "{"
            + "\"target_id\":\""
            + EscapeJson(targetId)
            + "\",\"damage\":"
            + damage.ToString(CultureInfo.InvariantCulture)
            + ","
            + "\"timestamp\":"
            + Time.realtimeSinceStartup.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent(
            "enemy_hit",
            json
        );
    }

    public void PlayerHit(float damage)
    {
        Debug.Log(
            "[SecureFPS TEST] PLAYER HIT DETECTED! Damage = " +
            damage.ToString(
                CultureInfo.InvariantCulture
            )
        );

        string json =
            "{"
            + "\"damage\":"
            + damage.ToString(
                CultureInfo.InvariantCulture
            )
            + "}";

        Debug.Log(
            "[SecureFPS TEST] PLAYER HIT JSON: " +
            json
        );

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
        Debug.Log(
            "[SecureFPS TEST] ENEMY KILLED: " +
            enemyName
        );

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
        Debug.Log(
            "[SecureFPS TEST] HEADSHOT DETECTED: " +
            enemyName
        );

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
        if (playerDeathSent)
        {
            return;
        }

        playerDeathSent = true;

        Debug.Log(
            "[SecureFPS TEST] PLAYER DEATH DETECTED"
        );

        SendEvent(
            "player_death","{}"
        );
        GameCompleted();
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

        Debug.Log(
            "[SecureFPS TEST] GAME COMPLETED"
        );

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

    public void AimBehavior(float rotationChange)
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

