
using Unity.FPS.Game;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;

namespace Unity.FPS.UI
{
    public class LoadSceneButton : MonoBehaviour
    {
        [Header("Scene Settings")]
        public string SceneName = "MainScene";

        private bool isLoading = false;

        void Update()
        {
            // Support keyboard/controller submit
            if (EventSystem.current != null &&
                EventSystem.current.currentSelectedGameObject == gameObject &&
                Input.GetButtonDown(GameConstants.k_ButtonNameSubmit))
            {
                LoadTargetScene();
            }
        }

        public void LoadTargetScene()
        {
            if (isLoading)
            {
                Debug.LogWarning("Scene loading is already in progress.");
                return;
            }

            if (string.IsNullOrWhiteSpace(SceneName))
            {
                Debug.LogError("SceneName is empty. Set it in the Inspector.");
                return;
            }

            Debug.Log("PLAY AGAIN CLICKED");
            Debug.Log("Target scene: " + SceneName);

            // Check whether the target scene is in Build Settings
            bool sceneExists = false;

            for (int i = 0; i < SceneManager.sceneCountInBuildSettings; i++)
            {
                string path = SceneUtility.GetScenePathByBuildIndex(i);
                string scene = System.IO.Path.GetFileNameWithoutExtension(path);

                if (scene == SceneName)
                {
                    sceneExists = true;
                    break;
                }
            }

            if (!sceneExists)
            {
                Debug.LogError(
                    "Scene '" + SceneName +
                    "' was not found in Build Settings."
                );
                return;
            }

            isLoading = true;

            Debug.Log("Loading scene: " + SceneName);

            SceneManager.LoadScene(
                SceneName,
                LoadSceneMode.Single
            );
        }
    }
}