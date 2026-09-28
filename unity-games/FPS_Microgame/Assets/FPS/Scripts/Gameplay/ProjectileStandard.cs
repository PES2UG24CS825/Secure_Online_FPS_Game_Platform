using System.Collections.Generic;
using Unity.FPS.Game;
using UnityEngine;

namespace Unity.FPS.Gameplay
{
    public class ProjectileStandard : ProjectileBase
    {
        [Header("General")]
        [Tooltip("Radius of this projectile's collision detection")]
        public float Radius = 0.01f;

        [Tooltip("Transform representing the root of the projectile (used for accurate collision detection)")]
        public Transform Root;

        [Tooltip("Transform representing the tip of the projectile (used for accurate collision detection)")]
        public Transform Tip;

        [Tooltip("LifeTime of the projectile")]
        public float MaxLifeTime = 5f;

        [Tooltip("VFX prefab to spawn upon impact")]
        public GameObject ImpactVfx;

        [Tooltip("LifeTime of the VFX before being destroyed")]
        public float ImpactVfxLifetime = 5f;

        [Tooltip("Offset along the hit normal where the VFX will be spawned")]
        public float ImpactVfxSpawnOffset = 0.1f;

        [Tooltip("Clip to play on impact")]
        public AudioClip ImpactSfxClip;

        [Tooltip("Layers this projectile can collide with")]
        public LayerMask HittableLayers = -1;

        [Header("Movement")]
        [Tooltip("Speed of the projectile")]
        public float Speed = 20f;

        [Tooltip("Downward acceleration from gravity")]
        public float GravityDownAcceleration = 0f;

        [Tooltip("Distance over which this projectile will correct its course to fit the intended trajectory")]
        public float TrajectoryCorrectionDistance = -1;

        [Tooltip("Determines if the projectile inherits the velocity that the weapon's muzzle had when firing")]
        public bool InheritWeaponVelocity = false;

        [Header("Damage")]
        [Tooltip("Damage of the projectile")]
        public float Damage = 40f;

        [Tooltip("Area of damage. Keep empty if you don't want area damage")]
        public DamageArea AreaOfDamage;

        [Header("Debug")]
        [Tooltip("Color of the projectile radius debug view")]
        public Color RadiusColor = Color.cyan * 0.2f;

        ProjectileBase m_ProjectileBase;
        Vector3 m_LastRootPosition;
        Vector3 m_Velocity;
        bool m_HasTrajectoryOverride;
        float m_ShootTime;
        Vector3 m_TrajectoryCorrectionVector;
        Vector3 m_ConsumedTrajectoryCorrectionVector;
        List<Collider> m_IgnoredColliders;
        bool m_TelemetryShotReported;
        bool m_TelemetryEnemyHitReported;
        bool m_TelemetryEnemyKillReported;

        const QueryTriggerInteraction k_TriggerInteraction = QueryTriggerInteraction.Collide;

        void OnEnable()
        {
            m_ProjectileBase = GetComponent<ProjectileBase>();

            DebugUtility.HandleErrorIfNullGetComponent<ProjectileBase, ProjectileStandard>(
                m_ProjectileBase,
                this,
                gameObject
            );

            m_ProjectileBase.OnShoot += OnShoot;

            Destroy(gameObject, MaxLifeTime);
        }

        new void OnShoot()
        {
            m_ShootTime = Time.time;
            m_LastRootPosition = Root.position;
            m_Velocity = transform.forward * Speed;
            m_IgnoredColliders = new List<Collider>();
            m_TelemetryShotReported = false;
            m_TelemetryEnemyHitReported = false;
            m_TelemetryEnemyKillReported = false;

            transform.position +=
                m_ProjectileBase.InheritedMuzzleVelocity * Time.deltaTime;

            // Ignore colliders belonging to the shooter
            Collider[] ownerColliders =
                m_ProjectileBase.Owner.GetComponentsInChildren<Collider>();

            m_IgnoredColliders.AddRange(ownerColliders);

            // Handle player shooting
            PlayerWeaponsManager playerWeaponsManager =
                m_ProjectileBase.Owner.GetComponent<PlayerWeaponsManager>();

            if (playerWeaponsManager && !m_TelemetryShotReported)
            {
                WeaponController activeWeapon =
                    playerWeaponsManager.GetActiveWeapon();

                if (activeWeapon && GameTelemetry.Instance != null)
                {
                    GameTelemetry.Instance.WeaponFire(activeWeapon.WeaponName);
                    m_TelemetryShotReported = true;
                }
            }

            if (playerWeaponsManager)
            {
                m_HasTrajectoryOverride = true;

                Vector3 cameraToMuzzle =
                    m_ProjectileBase.InitialPosition -
                    playerWeaponsManager.WeaponCamera.transform.position;

                m_TrajectoryCorrectionVector =
                    Vector3.ProjectOnPlane(
                        -cameraToMuzzle,
                        playerWeaponsManager.WeaponCamera.transform.forward
                    );

                if (TrajectoryCorrectionDistance == 0)
                {
                    transform.position += m_TrajectoryCorrectionVector;

                    m_ConsumedTrajectoryCorrectionVector =
                        m_TrajectoryCorrectionVector;
                }
                else if (TrajectoryCorrectionDistance < 0)
                {
                    m_HasTrajectoryOverride = false;
                }

                if (Physics.Raycast(
                    playerWeaponsManager.WeaponCamera.transform.position,
                    cameraToMuzzle.normalized,
                    out RaycastHit hit,
                    cameraToMuzzle.magnitude,
                    HittableLayers,
                    k_TriggerInteraction))
                {
                    if (IsHitValid(hit))
                    {
                        OnHit(
                            hit.point,
                            hit.normal,
                            hit.collider
                        );
                    }
                }
            }
        }

        void Update()
        {
            // Move projectile
            transform.position +=
                m_Velocity * Time.deltaTime;

            if (InheritWeaponVelocity)
            {
                transform.position +=
                    m_ProjectileBase.InheritedMuzzleVelocity *
                    Time.deltaTime;
            }

            // Trajectory correction
            if (m_HasTrajectoryOverride &&
                m_ConsumedTrajectoryCorrectionVector.sqrMagnitude <
                m_TrajectoryCorrectionVector.sqrMagnitude)
            {
                Vector3 correctionLeft =
                    m_TrajectoryCorrectionVector -
                    m_ConsumedTrajectoryCorrectionVector;

                float distanceThisFrame =
                    (Root.position - m_LastRootPosition).magnitude;

                Vector3 correctionThisFrame =
                    (distanceThisFrame / TrajectoryCorrectionDistance) *
                    m_TrajectoryCorrectionVector;

                correctionThisFrame =
                    Vector3.ClampMagnitude(
                        correctionThisFrame,
                        correctionLeft.magnitude
                    );

                m_ConsumedTrajectoryCorrectionVector +=
                    correctionThisFrame;

                if (m_ConsumedTrajectoryCorrectionVector.sqrMagnitude ==
                    m_TrajectoryCorrectionVector.sqrMagnitude)
                {
                    m_HasTrajectoryOverride = false;
                }

                transform.position += correctionThisFrame;
            }

            // Orient projectile towards velocity
            transform.forward =
                m_Velocity.normalized;

            // Gravity
            if (GravityDownAcceleration > 0)
            {
                m_Velocity +=
                    Vector3.down *
                    GravityDownAcceleration *
                    Time.deltaTime;
            }

            // Hit detection
            RaycastHit closestHit = new RaycastHit();
            closestHit.distance = Mathf.Infinity;

            bool foundHit = false;

            Vector3 displacementSinceLastFrame =
                Tip.position - m_LastRootPosition;

            RaycastHit[] hits = Physics.SphereCastAll(
                m_LastRootPosition,
                Radius,
                displacementSinceLastFrame.normalized,
                displacementSinceLastFrame.magnitude,
                HittableLayers,
                k_TriggerInteraction
            );

            foreach (var hit in hits)
            {
                if (IsHitValid(hit) &&
                    hit.distance < closestHit.distance)
                {
                    foundHit = true;
                    closestHit = hit;
                }
            }

            if (foundHit)
            {
                if (closestHit.distance <= 0f)
                {
                    closestHit.point = Root.position;
                    closestHit.normal = -transform.forward;
                }

                OnHit(
                    closestHit.point,
                    closestHit.normal,
                    closestHit.collider
                );
            }

            m_LastRootPosition = Root.position;
        }

        bool IsHitValid(RaycastHit hit)
        {
            if (hit.collider.GetComponent<IgnoreHitDetection>())
            {
                return false;
            }

            if (hit.collider.isTrigger &&
                hit.collider.GetComponent<Damageable>() == null &&
                hit.collider.GetComponentInParent<Damageable>() == null)
            {
                return false;
            }

            if (m_IgnoredColliders != null &&
                m_IgnoredColliders.Contains(hit.collider))
            {
                return false;
            }

            return true;
        }

        void OnHit(
            Vector3 point,
            Vector3 normal,
            Collider collider)
        {
            // =====================================================
            // DEBUG: PROJECTILE HIT
            // =====================================================

            Debug.Log(
                "[SecureFPS TEST] PROJECTILE HIT: " +
                (collider != null ? collider.name : "NULL")
            );

            bool telemetryHitRegistered = false;
            Damageable hitDamageable = null;
            Health hitHealth = null;
            Actor targetActor = null;
            float healthBeforeHit = 0f;
            bool playerOwnedShot =
                m_ProjectileBase.Owner != null &&
                m_ProjectileBase.Owner.GetComponent<PlayerWeaponsManager>() != null;

            if (collider != null)
            {
                hitDamageable = collider.GetComponent<Damageable>();
                if (hitDamageable == null)
                {
                    hitDamageable = collider.GetComponentInParent<Damageable>();
                }

                if (hitDamageable != null)
                {
                    hitHealth = hitDamageable.Health;
                    if (hitHealth != null)
                    {
                        healthBeforeHit = hitHealth.CurrentHealth;
                    }

                    targetActor = collider.GetComponentInParent<Actor>();
                }
            }

            // =====================================================
            // DAMAGE
            // =====================================================

            if (AreaOfDamage)
            {
                AreaOfDamage.InflictDamageInArea(
                    Damage,
                    point,
                    HittableLayers,
                    k_TriggerInteraction,
                    m_ProjectileBase.Owner
                );

                // Check collider and parent for Damageable
                if (hitDamageable != null)
                {
                    telemetryHitRegistered = true;
                }
            }
            else
            {
                if (hitDamageable != null)
                {
                    hitDamageable.InflictDamage(
                        Damage,
                        false,
                        m_ProjectileBase.Owner
                    );

                    telemetryHitRegistered = true;
                }
            }

            if (playerOwnedShot &&
                hitDamageable != null &&
                hitHealth != null &&
                targetActor != null &&
                targetActor.gameObject != m_ProjectileBase.Owner)
            {
                float actualDamage =
                    healthBeforeHit - hitHealth.CurrentHealth;

                if (actualDamage > 0f && GameTelemetry.Instance != null)
                {
                    if (!m_TelemetryEnemyHitReported)
                    {
                        GameTelemetry.Instance.EnemyHit(
                            targetActor.gameObject.name,
                            actualDamage
                        );
                        m_TelemetryEnemyHitReported = true;
                    }

                    if (healthBeforeHit > 0f &&
                        hitHealth.CurrentHealth <= 0f &&
                        !m_TelemetryEnemyKillReported)
                    {
                        GameTelemetry.Instance.EnemyKilled(
                            targetActor.gameObject.name
                        );
                        m_TelemetryEnemyKillReported = true;
                    }
                }
            }

            // =====================================================
            // PLAYER HIT TELEMETRY
            // =====================================================

            if (telemetryHitRegistered)
            {
                Debug.Log(
                    "[SecureFPS TEST] DAMAGEABLE HIT CONFIRMED"
                );
                GameTelemetry telemetry = GameTelemetry.Instance;

                if (telemetry == null)
                {
                    telemetry = FindObjectOfType<GameTelemetry>();
                    Debug.Log("[SecureFPS TEST] GameTelemetry.Instance was NULL, using FindObjectOfType fallback.");
                }
                if (telemetry != null)
                {
                    telemetry.PlayerHit(Damage);
                }
                else
                {
                    Debug.LogError("[SecureFPS TEST] GameTelemetry could not be found anywhere in the scene.");
                }
            }
           

            // =====================================================
            // IMPACT VFX
            // =====================================================

            if (ImpactVfx)
            {
                GameObject impactVfxInstance =
                    Instantiate(
                        ImpactVfx,
                        point + (normal * ImpactVfxSpawnOffset),
                        Quaternion.LookRotation(normal)
                    );

                if (ImpactVfxLifetime > 0)
                {
                    Destroy(
                        impactVfxInstance.gameObject,
                        ImpactVfxLifetime
                    );
                }
            }

            // =====================================================
            // IMPACT SOUND
            // =====================================================

            if (ImpactSfxClip)
            {
                AudioUtility.CreateSFX(
                    ImpactSfxClip,
                    point,
                    AudioUtility.AudioGroups.Impact,
                    1f,
                    3f
                );
            }

            // =====================================================
            // DESTROY PROJECTILE
            // =====================================================

            Destroy(this.gameObject);
        }

        void OnDrawGizmosSelected()
        {
            Gizmos.color = RadiusColor;

            Gizmos.DrawSphere(
                transform.position,
                Radius
            );
        }
    }
}