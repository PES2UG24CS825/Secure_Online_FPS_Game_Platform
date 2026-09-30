
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.Networking;

public class SecureFPSClient : MonoBehaviour
{
    public static SecureFPSClient Instance { get; private set; }

    [Header("Flask Server")]
    [SerializeField]
    private string serverUrl =
        "http://127.0.0.1:5000/api/game-events";

    [SerializeField]
    private string endServerUrl =
        "http://127.0.0.1:5000/api/game/end";

    private string gameSessionId;
    private string gameToken;

    private int pendingEventRequests = 0;
    private bool endRequestSent = false;
    private bool gameCompletedEventQueued = false;
    private bool serverStoppedSession = false;
    private bool demoBehaviorStarted = false;

    [System.Serializable]
    private class RealtimeDetectionResponse
    {
        public string status;
        public string random_forest;
        public string isolation_forest;
        public float risk_score;
        public bool alert_triggered;
        public string alert_severity;
        public string enforcement_state;
        public string enforcement_action;
    }

    [System.Serializable]
    private class GameEventResponse
    {
        public bool demo_mode;
        public string enforcement_state;
        public RealtimeDetectionResponse realtime_detection;
    }

    // =====================================================
    // INITIALIZATION
    // =====================================================

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }

        Instance = this;
        DontDestroyOnLoad(gameObject);

        ReadGameCredentials();

        Debug.Log("[SecureFPS] Client initialized.");
        Debug.Log("[SecureFPS] Session ID: " + gameSessionId);
        Debug.Log("[SecureFPS] Token received: " +
                  !string.IsNullOrEmpty(gameToken));
    }

    private void OnDestroy()
    {
        if (Instance == this)
            Instance = null;
    }

    // =====================================================
    // READ WEBGL URL CREDENTIALS
    // =====================================================

    private void ReadGameCredentials()
    {
        string url = Application.absoluteURL;

        if (string.IsNullOrEmpty(url))
        {
            Debug.LogWarning("[SecureFPS] Application URL is empty.");
            return;
        }

        int questionMark = url.IndexOf('?');

        if (questionMark < 0)
        {
            Debug.LogWarning("[SecureFPS] No query parameters found.");
            return;
        }

        string query = url.Substring(questionMark + 1);
        int fragment = query.IndexOf('#');

        if (fragment >= 0)
            query = query.Substring(0, fragment);

        string[] parameters = query.Split('&');

        foreach (string parameter in parameters)
        {
            string[] pair = parameter.Split(
                new char[] { '=' }, 2);

            if (pair.Length != 2)
                continue;

            string key = Uri.UnescapeDataString(
                pair[0].Replace("+", " "));

            string value = Uri.UnescapeDataString(
                pair[1].Replace("+", " "));

            if (key == "session_id")
                gameSessionId = value;

            if (key == "game_token")
                gameToken = value;
        }
    }

    // =====================================================
    // SEND TELEMETRY
    // =====================================================

    public void SendEvent(string eventType, string telemetryJson = "{}")
    {
        if (serverStoppedSession)
            return;

        if (endRequestSent)
        {
            Debug.LogWarning(
                "[SecureFPS] Event ignored; game is ending: " +
                eventType);
            return;
        }

        if (gameCompletedEventQueued && eventType != "game_completed")
        {
            Debug.LogWarning(
                "[SecureFPS] Event ignored after game completion: " +
                eventType);
            return;
        }

        if (string.IsNullOrEmpty(gameSessionId) ||
            string.IsNullOrEmpty(gameToken))
        {
            Debug.LogError(
                "[SecureFPS] Missing session ID or game token.");
            return;
        }

        if (eventType == "game_completed")
        {
            if (gameCompletedEventQueued)
                return;

            gameCompletedEventQueued = true;
        }

        StartCoroutine(
            SendEventCoroutine(eventType, telemetryJson));
    }

    private IEnumerator SendEventCoroutine(
        string eventType,
        string telemetryJson)
    {
        pendingEventRequests++;

        // The backend analyzes as soon as it receives game_completed.
        // Wait for earlier telemetry requests before sending that event.
        if (eventType == "game_completed")
        {
            while (pendingEventRequests > 1)
                yield return null;
        }

        if (string.IsNullOrEmpty(telemetryJson))
            telemetryJson = "{}";

        string json =
            "{"
            + "\"game_token\":\"" + EscapeJson(gameToken) + "\","
            + "\"session_id\":\"" + EscapeJson(gameSessionId) + "\","
            + "\"event_type\":\"" + EscapeJson(eventType) + "\","
            + "\"game\":\"FPS_Microgame\","
            + "\"telemetry\":" + telemetryJson
            + "}";

        byte[] body = Encoding.UTF8.GetBytes(json);

        using (UnityWebRequest request =
               new UnityWebRequest(serverUrl, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(body);
            request.downloadHandler =
                new DownloadHandlerBuffer();

            request.SetRequestHeader(
                "Content-Type", "application/json");

            Debug.Log(
                "[SecureFPS] Sending event: " + eventType);

            yield return request.SendWebRequest();

            if (request.result ==
                UnityWebRequest.Result.Success)
            {
                Debug.Log(
                    "[SecureFPS] Event sent: " + eventType +
                    " HTTP " + request.responseCode);

                Debug.Log(
                    "[SecureFPS] Response: " +
                    request.downloadHandler.text);

                HandleBackendResponse(
                    eventType,
                    request.downloadHandler.text);
            }
            else
            {
                Debug.LogError(
                    "[SecureFPS] Event failed: " + eventType +
                    " Error: " + request.error +
                    " HTTP " + request.responseCode);

                Debug.LogError(
                    "[SecureFPS] Response: " +
                    request.downloadHandler.text);

                HandleBackendResponse(
                    eventType,
                    request.downloadHandler.text);
            }
        }

        pendingEventRequests--;

        // Only request finalization after the completion
        // telemetry request has finished.
        if (eventType == "game_completed")
        {
            FinishGame();
        }
    }

    private void HandleBackendResponse(string eventType, string responseJson)
    {
        if (string.IsNullOrEmpty(responseJson))
            return;

        GameEventResponse response;
        try
        {
            response = JsonUtility.FromJson<GameEventResponse>(responseJson);
        }
        catch (Exception exception)
        {
            Debug.LogWarning("[SecureFPS] Could not parse server detection response: " + exception.Message);
            return;
        }

        if (response == null)
            return;

        if (eventType == "game_started" && response.demo_mode && !demoBehaviorStarted)
        {
            demoBehaviorStarted = true;
            if (GameTelemetry.Instance != null)
                GameTelemetry.Instance.StartDemoTelemetry();
        }

        RealtimeDetectionResponse detection = response.realtime_detection;
        if (detection != null && detection.status == "success" && detection.alert_triggered)
        {
            if (detection.enforcement_state == "restricted" &&
                detection.enforcement_action == "temporary_restriction")
            {
                StopForServerRestriction();
            }
            else
            {
                ShowDetectionOverlay(
                    "SUSPICIOUS GAMEPLAY DETECTED\n" +
                    "Unusual gameplay behavior has been detected. Your session is being monitored.",
                    new Color(0.55f, 0.31f, 0.04f, 0.96f));
            }
        }

        if (response.enforcement_state == "restricted")
            StopForServerRestriction();
    }

    private void StopForServerRestriction()
    {
        if (serverStoppedSession)
            return;

        serverStoppedSession = true;
        endRequestSent = true;
        if (GameTelemetry.Instance != null)
            GameTelemetry.Instance.StopDemoTelemetry();

        Time.timeScale = 0f;
        ShowDetectionOverlay(
            "CHEATING BEHAVIOR FLAGGED\n" +
            "Your gameplay session has been stopped because the server detected high-confidence suspicious behavior. This test account is restricted pending review.",
            new Color(0.48f, 0.08f, 0.1f, 0.98f));
    }

    private void ShowDetectionOverlay(string message, Color backgroundColor)
    {
        GameObject existing = GameObject.Find("SecureFPSDetectionOverlay");
        if (existing != null)
            Destroy(existing);

        GameObject root = new GameObject("SecureFPSDetectionOverlay");
        DontDestroyOnLoad(root);
        Canvas canvas = root.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.overrideSorting = true;
        canvas.sortingOrder = short.MaxValue;
        root.AddComponent<CanvasScaler>().uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        root.AddComponent<GraphicRaycaster>();

        GameObject panel = new GameObject("DetectionPanel");
        panel.transform.SetParent(root.transform, false);
        RectTransform panelRect = panel.AddComponent<RectTransform>();
        panelRect.anchorMin = new Vector2(0.1f, 0.34f);
        panelRect.anchorMax = new Vector2(0.9f, 0.66f);
        panelRect.offsetMin = Vector2.zero;
        panelRect.offsetMax = Vector2.zero;
        panel.AddComponent<Image>().color = backgroundColor;

        GameObject label = new GameObject("DetectionMessage");
        label.transform.SetParent(panel.transform, false);
        RectTransform labelRect = label.AddComponent<RectTransform>();
        labelRect.anchorMin = Vector2.zero;
        labelRect.anchorMax = Vector2.one;
        labelRect.offsetMin = new Vector2(24f, 18f);
        labelRect.offsetMax = new Vector2(-24f, -18f);
        Text text = label.AddComponent<Text>();
        text.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        text.fontSize = 26;
        text.alignment = TextAnchor.MiddleCenter;
        text.horizontalOverflow = HorizontalWrapMode.Wrap;
        text.verticalOverflow = VerticalWrapMode.Overflow;
        text.color = Color.white;
        text.text = message;
    }

    // =====================================================
    // AUTOMATIC END API
    // =====================================================

    public void FinishGame()
    {
        if (endRequestSent)
            return;

        if (string.IsNullOrEmpty(gameSessionId))
        {
            Debug.LogError(
                "[SecureFPS] Cannot end game: session ID missing.");
            return;
        }

        endRequestSent = true;
        StartCoroutine(FinishGameCoroutine());
    }

    private IEnumerator FinishGameCoroutine()
    {
        // Wait for all queued telemetry requests to finish.
        while (pendingEventRequests > 0)
            yield return null;

        Debug.Log(
            "[SecureFPS] All telemetry sent. Calling game/end.");

        string json =
            "{"
            + "\"session_id\":\"" +
            EscapeJson(gameSessionId)
            + "\""
            + "}";

        byte[] body = Encoding.UTF8.GetBytes(json);

        using (UnityWebRequest request =
               new UnityWebRequest(endServerUrl, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(body);
            request.downloadHandler =
                new DownloadHandlerBuffer();

            request.SetRequestHeader(
                "Content-Type", "application/json");

            yield return request.SendWebRequest();

            if (request.result ==
                UnityWebRequest.Result.Success)
            {
                Debug.Log(
                    "[SecureFPS] END API SUCCESS. HTTP " +
                    request.responseCode);

                Debug.Log(
                    "[SecureFPS] End response: " +
                    request.downloadHandler.text);
            }
            else
            {
                Debug.LogError(
                    "[SecureFPS] END API FAILED. Error: " +
                    request.error + " HTTP " +
                    request.responseCode);

                Debug.LogError(
                    "[SecureFPS] End response: " +
                    request.downloadHandler.text);
            }
        }
    }

    // =====================================================
    // JSON ESCAPE
    // =====================================================

    private string EscapeJson(string value)
    {
        if (string.IsNullOrEmpty(value))
            return "";

        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"");
    }
}