
using Unity.FPS.Game;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Unity.FPS.Game
{
    public class GameFlowManager : MonoBehaviour
    {
        [Header("Parameters")]
        [Tooltip("Duration of the fade-to-black at the end of the game")]
        public float EndSceneLoadDelay = 3f;

        [Tooltip("The canvas group of the fade-to-black screen")]
        public CanvasGroup EndGameFadeCanvasGroup;

        [Header("Win")]
        public string WinSceneName = "WinScene";

        [Tooltip("Delay before the win fade starts")]
        public float DelayBeforeFadeToBlack = 4f;

        public string WinGameMessage;
        public float DelayBeforeWinMessage = 2f;
        public AudioClip VictorySound;

        [Header("Lose")]
        public string LoseSceneName = "LoseScene";

        [Header("Gameplay Scene")]
        public string GameplaySceneName = "MainScene";

        [Header("Gameplay UI")]
        [Tooltip("Assign the persistent gameplay HUD visual root only")]
        public GameObject GameplayHUDRoot;

        [Tooltip("Assign the persistent in-game menu visual root only")]
        public GameObject InGameMenuRoot;

        public bool GameIsEnding { get; private set; }

        float m_TimeStartFade;
        float m_TimeLoadEndGameScene;
        string m_SceneToLoad;

        void OnEnable()
        {
            SceneManager.sceneLoaded += OnSceneLoaded;
        }

        void OnDisable()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
        }

        void Awake()
        {
            EventManager.AddListener<AllObjectivesCompletedEvent>(
                OnAllObjectivesCompleted);

            EventManager.AddListener<PlayerDeathEvent>(
                OnPlayerDeath);

            ResetFade();
        }

        void Start()
        {
            AudioUtility.SetMasterVolume(1f);

            // Set UI visibility for the scene active at startup.
            ApplySceneUI(SceneManager.GetActiveScene().name);
        }

        void Update()
        {
            if (!GameIsEnding)
                return;

            float timeRatio = 0f;

            if (Time.time >= m_TimeStartFade)
            {
                if (EndSceneLoadDelay <= 0f)
                {
                    timeRatio = 1f;
                }
                else
                {
                    timeRatio = Mathf.Clamp01(
                        (Time.time - m_TimeStartFade) /
                        EndSceneLoadDelay);
                }
            }

            if (EndGameFadeCanvasGroup != null)
                EndGameFadeCanvasGroup.alpha = timeRatio;

            AudioUtility.SetMasterVolume(1f - timeRatio);

            if (Time.time >= m_TimeLoadEndGameScene)
            {
                Time.timeScale = 1f;

                Debug.Log(
                    "[GameFlowManager] Loading result scene: " +
                    m_SceneToLoad);

                // Prevent another end-game event during the transition.
                GameIsEnding = false;

                SceneManager.LoadScene(
                    m_SceneToLoad,
                    LoadSceneMode.Single);

                // Reset persistent fade after loading the result scene.
                ResetFade();

                AudioUtility.SetMasterVolume(1f);
            }
        }

        void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            Debug.Log(
                "[GameFlowManager] Scene loaded: " + scene.name);

            // Every newly loaded scene gets the correct UI visibility.
            ApplySceneUI(scene.name);

            // Ensure a previous fade does not cover the new scene.
            ResetFade();

            // A newly loaded gameplay scene is ready for a new run.
            if (scene.name == GameplaySceneName)
            {
                GameIsEnding = false;
                Time.timeScale = 1f;
                AudioUtility.SetMasterVolume(1f);
            }
        }

        void ApplySceneUI(string sceneName)
        {
            bool isGameplayScene =
                sceneName == GameplaySceneName;

            if (GameplayHUDRoot != null)
            {
                GameplayHUDRoot.SetActive(isGameplayScene);
            }

            if (InGameMenuRoot != null)
            {
                InGameMenuRoot.SetActive(isGameplayScene);
            }

            Debug.Log(
                "[GameFlowManager] Scene: " + sceneName +
                " | Gameplay HUD visible: " + isGameplayScene);
        }

        void OnAllObjectivesCompleted(
            AllObjectivesCompletedEvent evt)
        {
            EndGame(true);
        }

        void OnPlayerDeath(PlayerDeathEvent evt)
        {
            EndGame(false);
        }

        void EndGame(bool win)
        {
            // Prevent repeated event callbacks from restarting the fade.
            if (GameIsEnding)
                return;

            if (EndGameFadeCanvasGroup == null)
            {
                Debug.LogError(
                    "[GameFlowManager] EndGameFadeCanvasGroup is not assigned.");
                return;
            }

            if (win && string.IsNullOrWhiteSpace(WinSceneName))
            {
                Debug.LogError(
                    "[GameFlowManager] WinSceneName is empty.");
                return;
            }

            if (!win && string.IsNullOrWhiteSpace(LoseSceneName))
            {
                Debug.LogError(
                    "[GameFlowManager] LoseSceneName is empty.");
                return;
            }

            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
            Time.timeScale = 1f;

            GameIsEnding = true;

            EndGameFadeCanvasGroup.gameObject.SetActive(true);
            EndGameFadeCanvasGroup.alpha = 0f;
            EndGameFadeCanvasGroup.interactable = false;
            EndGameFadeCanvasGroup.blocksRaycasts = false;

            if (win)
            {
                m_SceneToLoad = WinSceneName;

                m_TimeStartFade =
                    Time.time +
                    Mathf.Max(0f, DelayBeforeFadeToBlack);

                m_TimeLoadEndGameScene =
                    m_TimeStartFade +
                    Mathf.Max(0f, EndSceneLoadDelay);

                if (VictorySound != null)
                {
                    var audioSource =
                        gameObject.AddComponent<AudioSource>();

                    audioSource.clip = VictorySound;
                    audioSource.playOnAwake = false;
                    audioSource.outputAudioMixerGroup =
                        AudioUtility.GetAudioGroup(
                            AudioUtility.AudioGroups.HUDVictory);

                    audioSource.PlayScheduled(
                        AudioSettings.dspTime +
                        Mathf.Max(0f, DelayBeforeWinMessage));
                }

                DisplayMessageEvent displayMessage =
                    Events.DisplayMessageEvent;

                displayMessage.Message = WinGameMessage;
                displayMessage.DelayBeforeDisplay =
                    DelayBeforeWinMessage;

                EventManager.Broadcast(displayMessage);
            }
            else
            {
                m_SceneToLoad = LoseSceneName;

                m_TimeStartFade = Time.time;

                m_TimeLoadEndGameScene =
                    m_TimeStartFade +
                    Mathf.Max(0f, EndSceneLoadDelay);
            }
        }

        void ResetFade()
        {
            if (EndGameFadeCanvasGroup == null)
                return;

            EndGameFadeCanvasGroup.alpha = 0f;
            EndGameFadeCanvasGroup.interactable = false;
            EndGameFadeCanvasGroup.blocksRaycasts = false;

            EndGameFadeCanvasGroup.gameObject.SetActive(false);
        }

        void OnDestroy()
        {
            EventManager.RemoveListener<AllObjectivesCompletedEvent>(
                OnAllObjectivesCompleted);

            EventManager.RemoveListener<PlayerDeathEvent>(
                OnPlayerDeath);
        }
    }
}