using UnityEngine;
using System.Collections.Generic;

public class PlayerTelemetry : MonoBehaviour
{
    [Header("Telemetry Settings")]
    [SerializeField]
    private float sendInterval = 2.0f;

    [Header("Aim Settings")]
    [SerializeField]
    private float aimSendInterval = 0.5f;

    [SerializeField]
    private float aimSampleInterval = 0.1f; // 10Hz kinematics (Phase 1)

    private float movementTimer;
    private float aimTimer;
    private float aimSampleTimer;

    private CharacterController characterController;
    private Transform movementTransform;

    private Vector3 lastPosition;
    private Vector3 lastForward;
    private Vector3 lastAimSampleForward;

    private float elapsedSinceMovementSample;
    private HashSet<string> currentTargetsInCone = new HashSet<string>();

    private void Start()
    {
        characterController = GetComponentInParent<CharacterController>();

        movementTransform = characterController != null
            ? characterController.transform
            : transform;

        lastPosition = movementTransform.position;
        lastForward = transform.forward;
        lastAimSampleForward = transform.forward;

        movementTimer = sendInterval;
        aimTimer = aimSendInterval;
        aimSampleTimer = aimSampleInterval;

        elapsedSinceMovementSample = 0f;

        Debug.Log("[SecureFPS] PlayerTelemetry started with 10Hz aim_sample.");
    }

    private void Update()
    {
        movementTimer -= Time.deltaTime;
        aimTimer -= Time.deltaTime;
        aimSampleTimer -= Time.deltaTime;
        elapsedSinceMovementSample += Time.deltaTime;

        // ---------------------------------------------
        // 1. FAST 10Hz AIM SAMPLE TELEMETRY (every 0.1s)
        // ---------------------------------------------
        if (aimSampleTimer <= 0f)
        {
            SendAimSample();
            aimSampleTimer = aimSampleInterval;
        }

        // ---------------------------------------------
        // 2. MOVEMENT TELEMETRY (every 2.0s)
        // ---------------------------------------------
        if (movementTimer <= 0f)
        {
            SendPlayerBehavior();
            movementTimer = sendInterval;
            elapsedSinceMovementSample = 0f;
        }

        // ---------------------------------------------
        // 3. LEGACY AIM BEHAVIOR (every 0.5s)
        // ---------------------------------------------
        if (aimTimer <= 0f)
        {
            SendAimBehavior();
            aimTimer = aimSendInterval;
        }
    }

    // =========================================================
    // 10Hz AIM SAMPLE
    // =========================================================

    private void SendAimSample()
    {
        if (GameTelemetry.Instance == null) return;

        Vector3 currentForward = transform.forward;
        float angleDeg = Vector3.Angle(lastAimSampleForward, currentForward);
        float dt = Mathf.Max(0.001f, aimSampleInterval);
        float angularVelocityDegS = angleDeg / dt;

        float yaw = transform.eulerAngles.y;
        float pitch = transform.eulerAngles.x;
        if (pitch > 180f) pitch -= 360f;

        if (!float.IsNaN(angularVelocityDegS) && !float.IsInfinity(angularVelocityDegS))
        {
            GameTelemetry.Instance.AimSample(angularVelocityDegS, yaw, pitch);
        }

        lastAimSampleForward = currentForward;
    }

    // =========================================================
    // MOVEMENT
    // =========================================================

    private void SendPlayerBehavior()
    {
        if (GameTelemetry.Instance == null) return;

        Vector3 currentPosition = movementTransform.position;
        float distance = Vector3.Distance(currentPosition, lastPosition);
        float speed = 0f;

        if (characterController != null)
        {
            speed = characterController.velocity.magnitude;
        }
        else if (elapsedSinceMovementSample > 0f)
        {
            speed = distance / elapsedSinceMovementSample;
        }

        if (float.IsNaN(speed) || float.IsInfinity(speed))
        {
            lastPosition = currentPosition;
            return;
        }

        bool grounded = characterController != null && characterController.isGrounded;

        GameTelemetry.Instance.PlayerBehavior(
            speed,
            currentPosition.x,
            currentPosition.y,
            currentPosition.z,
            grounded
        );

        lastPosition = currentPosition;
    }

    // =========================================================
    // AIM
    // =========================================================

    private void SendAimBehavior()
    {
        if (GameTelemetry.Instance == null) return;

        Vector3 currentForward = transform.forward;
        float rotationChange = Vector3.Angle(lastForward, currentForward);

        if (float.IsNaN(rotationChange) || float.IsInfinity(rotationChange))
        {
            lastForward = currentForward;
            return;
        }

        GameTelemetry.Instance.AimBehavior(rotationChange);
        lastForward = currentForward;
    }

    // =========================================================
    // PUBLIC EVENTS
    // =========================================================

    public void ReportTargetAcquired(string enemyId, float distance, bool visibleThroughWall)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.TargetAcquired(enemyId, distance, visibleThroughWall);
    }

    public void ReportHitDetail(string targetId, string bodyPart, float distance, float damage)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.HitDetail(targetId, bodyPart, distance, damage);
    }

    public void ReportWeaponFire(string weaponName, float aimErrorDeg = -1f, string targetId = null)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.WeaponFire(weaponName, aimErrorDeg, targetId);
    }

    public void ReportWeaponFire(string weaponName)
    {
        ReportWeaponFire(weaponName, -1f, null);
    }

    public void ReportPlayerHit(float damage)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.PlayerHit(damage);
    }

    public void ReportEnemyKilled(string enemyName)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.EnemyKilled(enemyName);
    }

    public void ReportHeadshot(string enemyName)
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.Headshot(enemyName);
    }

    public void ReportPlayerDeath()
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.PlayerDeath();
    }

    public void ReportGameCompleted()
    {
        if (GameTelemetry.Instance == null) return;
        GameTelemetry.Instance.GameCompleted();
    }
}
