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
    private int eventSequence = 0;

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

        secureClient = GetComponent<SecureFPSClient>();

        if (secureClient != null)
        {
            Debug.Log("[SecureFPS] SecureFPSClient found on same GameObject.");
        }
        else
        {
            Debug.LogWarning("[SecureFPS] SecureFPSClient not on same GameObject. Will search when sending events.");
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
    // GENERIC EVENT WITH SEQ AND TIMESTAMP
    // =========================================================

    private string WrapTelemetryJson(string innerJson)
    {
        eventSequence++;
        float nowSec = Time.realtimeSinceStartup;
        string prefix = "\"seq\":" + eventSequence + ",\"timestamp\":" + nowSec.ToString(CultureInfo.InvariantCulture);

        if (string.IsNullOrEmpty(innerJson) || innerJson.Trim() == "{}")
        {
            return "{" + prefix + "}";
        }

        string trimmed = innerJson.Trim();
        if (trimmed.StartsWith("{") && trimmed.EndsWith("}"))
        {
            string body = trimmed.Substring(1, trimmed.Length - 2).Trim();
            if (body.Length > 0)
            {
                if (!body.Contains("\"seq\":"))
                {
                    body = prefix + "," + body;
                }
                return "{" + body + "}";
            }
            return "{" + prefix + "}";
        }
        return "{" + prefix + "}";
    }

    public void SendEvent(
        string eventType,
        string telemetryJson = "{}"
    )
    {
        if (secureClient == null)
        {
            secureClient = GetComponent<SecureFPSClient>();
        }
        if (secureClient == null)
        {
            secureClient = SecureFPSClient.Instance;
        }
        if (secureClient == null)
        {
            secureClient = FindObjectOfType<SecureFPSClient>();
        }

        if (secureClient == null)
        {
            Debug.LogError("[SecureFPS] No SecureFPSClient found. Event not sent: " + eventType);
            return;
        }

        string wrappedJson = WrapTelemetryJson(telemetryJson);
        secureClient.SendEvent(eventType, wrappedJson);
    }

    // =========================================================
    // PHASE 1 TELEMETRY EVENTS
    // =========================================================

    public void AimSample(float angularVelocityDegS, float yaw, float pitch)
    {
        string json =
            "{"
            + "\"angular_velocity_deg_s\":"
            + angularVelocityDegS.ToString(CultureInfo.InvariantCulture)
            + ",\"yaw\":"
            + yaw.ToString(CultureInfo.InvariantCulture)
            + ",\"pitch\":"
            + pitch.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent("aim_sample", json);
    }

    public void TargetAcquired(string enemyId, float distance, bool visibleThroughWall)
    {
        string json =
            "{"
            + "\"enemy_id\":\""
            + EscapeJson(enemyId)
            + "\",\"distance\":"
            + distance.ToString(CultureInfo.InvariantCulture)
            + ",\"visible_through_wall\":"
            + (visibleThroughWall ? "true" : "false")
            + "}";

        SendEvent("target_acquired", json);
    }

    public void HitDetail(string targetId, string bodyPart, float distance, float damage)
    {
        string json =
            "{"
            + "\"target_id\":\""
            + EscapeJson(targetId)
            + "\",\"body_part\":\""
            + EscapeJson(bodyPart)
            + "\",\"distance\":"
            + distance.ToString(CultureInfo.InvariantCulture)
            + ",\"damage\":"
            + damage.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent("hit_detail", json);
    }

    public void WeaponFire(string weaponName, float aimErrorDeg = -1f, string targetId = null)
    {
        string targetIdStr = string.IsNullOrEmpty(targetId) ? "null" : ("\"" + EscapeJson(targetId) + "\"");
        string aimErrorStr = aimErrorDeg >= 0f ? aimErrorDeg.ToString(CultureInfo.InvariantCulture) : "null";

        string json =
            "{"
            + "\"weapon\":\""
            + EscapeJson(weaponName)
            + "\",\"aim_error_deg\":"
            + aimErrorStr
            + ",\"target_id\":"
            + targetIdStr
            + "}";

        SendEvent("weapon_fire", json);
    }

    // Overload for backward compatibility
    public void WeaponFire(string weaponName)
    {
        WeaponFire(weaponName, -1f, null);
    }

    public void EnemySpawned(string enemyId)
    {
        string json =
            "{"
            + "\"enemy_id\":\"" + EscapeJson(enemyId) + "\""
            + "}";

        SendEvent("enemy_spawned", json);
    }

    public void EnemyHit(string targetId, float damage)
    {
        string json =
            "{"
            + "\"target_id\":\""
            + EscapeJson(targetId)
            + "\",\"damage\":"
            + damage.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent("enemy_hit", json);
    }

    public void PlayerHit(float damage)
    {
        string json =
            "{"
            + "\"damage\":"
            + damage.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent("player_hit", json);
    }

    public void EnemyKilled(string enemyName)
    {
        string json =
            "{"
            + "\"enemy\":\""
            + EscapeJson(enemyName)
            + "\""
            + "}";

        SendEvent("enemy_killed", json);
    }

    public void Headshot(string enemyName = "")
    {
        string json =
            "{"
            + "\"enemy\":\""
            + EscapeJson(enemyName)
            + "\""
            + "}";

        SendEvent("headshot", json);
    }

    public void PlayerDeath()
    {
        if (playerDeathSent)
        {
            return;
        }

        playerDeathSent = true;
        SendEvent("player_death", "{}");
        GameCompleted();
    }

    public void GameCompleted()
    {
        if (gameCompleted)
        {
            return;
        }

        gameCompleted = true;
        SendEvent("game_completed", "{}");
    }

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
            + speed.ToString(CultureInfo.InvariantCulture)
            + ","
            + "\"position\":{"
            + "\"x\":"
            + x.ToString(CultureInfo.InvariantCulture)
            + ","
            + "\"y\":"
            + y.ToString(CultureInfo.InvariantCulture)
            + ","
            + "\"z\":"
            + z.ToString(CultureInfo.InvariantCulture)
            + "},"
            + "\"grounded\":"
            + grounded.ToString().ToLower()
            + "}";

        SendEvent("player_behavior", json);
    }

    public void AimBehavior(float rotationChange)
    {
        string json =
            "{"
            + "\"rotation_change\":"
            + rotationChange.ToString(CultureInfo.InvariantCulture)
            + "}";

        SendEvent("aim_behavior", json);
    }

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
