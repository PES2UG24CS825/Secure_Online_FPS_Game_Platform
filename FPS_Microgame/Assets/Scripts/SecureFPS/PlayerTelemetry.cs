using UnityEngine;

public class PlayerTelemetry : MonoBehaviour
{
    [Header("Telemetry Settings")]
    [SerializeField]
    private float sendInterval = 2.0f;

    [Header("Aim Settings")]
    [SerializeField]
    private float aimSendInterval = 0.5f;

    private float movementTimer;
    private float aimTimer;

    private CharacterController characterController;

    private Vector3 lastPosition;
    private Vector3 lastForward;

    private float elapsedSinceMovementSample;

    private void Start()
    {
        characterController =
            GetComponent<CharacterController>();

        lastPosition =
            transform.position;

        lastForward =
            transform.forward;

        movementTimer =
            sendInterval;

        aimTimer =
            aimSendInterval;

        elapsedSinceMovementSample = 0f;

        Debug.Log(
            "[SecureFPS] PlayerTelemetry started."
        );
    }

    private void Update()
    {
        movementTimer -= Time.deltaTime;
        aimTimer -= Time.deltaTime;

        elapsedSinceMovementSample +=
            Time.deltaTime;

        // ---------------------------------------------
        // MOVEMENT TELEMETRY
        // ---------------------------------------------

        if (movementTimer <= 0f)
        {
            SendPlayerBehavior();

            movementTimer =
                sendInterval;

            elapsedSinceMovementSample = 0f;
        }

        // ---------------------------------------------
        // AIM TELEMETRY
        // ---------------------------------------------

        if (aimTimer <= 0f)
        {
            SendAimBehavior();

            aimTimer =
                aimSendInterval;
        }
    }

    // =========================================================
    // MOVEMENT
    // =========================================================

    private void SendPlayerBehavior()
    {
        if (GameTelemetry.Instance == null)
        {
            Debug.LogError(
                "[SecureFPS] GameTelemetry.Instance not found."
            );

            return;
        }

        Vector3 currentPosition =
            transform.position;

        float distance =
            Vector3.Distance(
                currentPosition,
                lastPosition
            );

        float speed = 0f;

        if (elapsedSinceMovementSample > 0f)
        {
            speed =
                distance /
                elapsedSinceMovementSample;
        }

        bool grounded = false;

        if (characterController != null)
        {
            grounded =
                characterController.isGrounded;
        }

        GameTelemetry.Instance.PlayerBehavior(
            speed,
            currentPosition.x,
            currentPosition.y,
            currentPosition.z,
            grounded
        );

        lastPosition =
            currentPosition;
    }

    // =========================================================
    // AIM
    // =========================================================

    private void SendAimBehavior()
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        Vector3 currentForward =
            transform.forward;

        float rotationChange =
            Vector3.Angle(
                lastForward,
                currentForward
            );

        GameTelemetry.Instance.AimBehavior(
            rotationChange
        );

        lastForward =
            currentForward;
    }

    // =========================================================
    // OPTIONAL PUBLIC EVENTS
    // =========================================================

    public void ReportWeaponFire(
        string weaponName
    )
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.WeaponFire(
            weaponName
        );
    }

    public void ReportPlayerHit(
        float damage
    )
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.PlayerHit(
            damage
        );
    }

    public void ReportEnemyKilled(
        string enemyName
    )
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.EnemyKilled(
            enemyName
        );
    }

    public void ReportHeadshot(
        string enemyName
    )
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.Headshot(
            enemyName
        );
    }

    public void ReportPlayerDeath()
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.PlayerDeath();
    }

    public void ReportGameCompleted()
    {
        if (GameTelemetry.Instance == null)
        {
            return;
        }

        GameTelemetry.Instance.GameCompleted();
    }
}