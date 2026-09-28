using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public class SecureFPSClient : MonoBehaviour
{
    public static SecureFPSClient Instance { get; private set; }

    [Header("Flask Server")]
    [SerializeField]
    private string serverUrl =
        "http://127.0.0.1:5000/api/game-events";

    private string gameSessionId;
    private string gameToken;

    // =========================================================
    // UNITY INITIALIZATION
    // =========================================================

    private void Awake()
    {
        if (
            Instance != null &&
            Instance != this
        )
        {
            Destroy(gameObject);
            return;
        }

        Instance = this;

        ReadGameCredentials();

        Debug.Log(
            "[SecureFPS] SecureFPSClient initialized."
        );

        Debug.Log(
            "[SecureFPS] Session ID: " +
            gameSessionId
        );

        Debug.Log(
            "[SecureFPS] Game token received: " +
            (!string.IsNullOrEmpty(gameToken))
        );
    }

    private void OnDestroy()
    {
        if (Instance == this)
        {
            Instance = null;
        }
    }

    // =========================================================
    // READ SESSION FROM WEBGL URL
    // =========================================================

    private void ReadGameCredentials()
    {
        string url =
            Application.absoluteURL;

        Debug.Log("[SecureFPS] Game URL received.");

        if (
            string.IsNullOrEmpty(url)
        )
        {
            Debug.LogWarning(
                "[SecureFPS] Application URL is empty."
            );

            return;
        }

        int questionMark =
            url.IndexOf("?");

        if (questionMark < 0)
        {
            Debug.LogWarning(
                "[SecureFPS] No query parameters found."
            );

            return;
        }

        string query =
            url.Substring(
                questionMark + 1
            );

        string[] parameters =
            query.Split('&');

        foreach (
            string parameter
            in parameters
        )
        {
            string[] pair =
                parameter.Split(
                    new char[] { '=' },
                    2
                );

            if (pair.Length != 2)
            {
                continue;
            }

            string key =
                pair[0];

            string value =
                Uri.UnescapeDataString(
                    pair[1]
                );

            if (key == "session_id")
            {
                gameSessionId =
                    value;
            }

            if (key == "game_token")
            {
                gameToken =
                    value;
            }
        }
    }

    // =========================================================
    // SEND TELEMETRY EVENT
    // =========================================================

    public void SendEvent(
        string eventType,
        string telemetryJson
    )
    {
        if (
            string.IsNullOrEmpty(
                gameToken
            )
        )
        {
            Debug.LogError(
                "[SecureFPS] Game token is missing."
            );

            return;
        }

        if (
            string.IsNullOrEmpty(
                gameSessionId
            )
        )
        {
            Debug.LogError(
                "[SecureFPS] Session ID is missing."
            );

            return;
        }

        StartCoroutine(
            SendEventCoroutine(
                eventType,
                telemetryJson
            )
        );
    }

    // =========================================================
    // HTTP REQUEST
    // =========================================================

    private IEnumerator SendEventCoroutine(
        string eventType,
        string telemetryJson
    )
    {
        if (
            string.IsNullOrEmpty(
                telemetryJson
            )
        )
        {
            telemetryJson =
                "{}";
        }

        string json =
            "{"
            + "\"game_token\":\""
            + EscapeJson(gameToken)
            + "\","
            + "\"session_id\":\""
            + EscapeJson(gameSessionId)
            + "\","
            + "\"event_type\":\""
            + EscapeJson(eventType)
            + "\","
            + "\"game\":\"FPS_Microgame\","
            + "\"telemetry\":"
            + telemetryJson
            + "}"
            ;

        Debug.Log(
            "[SecureFPS] Preparing event payload: " +
            eventType
        );

        byte[] body =
            Encoding.UTF8.GetBytes(
                json
            );

        using (
            UnityWebRequest request =
                new UnityWebRequest(
                    serverUrl,
                    "POST"
                )
        )
        {
            request.uploadHandler =
                new UploadHandlerRaw(
                    body
                );

            request.downloadHandler =
                new DownloadHandlerBuffer();

            request.SetRequestHeader(
                "Content-Type",
                "application/json"
            );

            Debug.Log(
                "[SecureFPS] Sending event: " +
                eventType
            );

            yield return request.SendWebRequest();

            if (
                request.result ==
                UnityWebRequest.Result.Success
            )
            {
                Debug.Log(
                    "[SecureFPS] Event sent successfully: "
                    + eventType
                    + " HTTP "
                    + request.responseCode
                );

                Debug.Log(
                    "[SecureFPS] Server response: "
                    + request.downloadHandler.text
                );
            }
            else
            {
                Debug.LogError(
                    "[SecureFPS] Failed to send event: "
                    + eventType
                    + " Error: "
                    + request.error
                    + " HTTP "
                    + request.responseCode
                );

                Debug.LogError(
                    "[SecureFPS] Response: "
                    + request.downloadHandler.text
                );
            }
        }
    }

    // =========================================================
    // JSON ESCAPE
    // =========================================================

    private string EscapeJson(
        string value
    )
    {
        if (
            string.IsNullOrEmpty(value)
        )
        {
            return "";
        }

        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"");
    }
}