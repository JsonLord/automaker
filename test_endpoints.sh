#!/bin/bash

BASE_URL="https://leon4gr45-automaker.hf.space"
# In a real environment, you would use HF_TOKEN. Here we use it if available.
TOKEN="${HF_TOKEN:-mock_token}"

declare -A ENDPOINTS=(
  ["/api/argus/modes"]="GET"
  ["/api/argus/mode?projectId=test-1"]="GET"
  ["/api/argus/mode"]="PUT"
  ["/api/argus/mode/command"]="POST"
  ["/api/argus/mode/plan"]="POST"
  ["/api/argus/mode/run"]="POST"
  ["/api/argus/mode/runs/1"]="GET"
  ["/api/argus/mode/runs/1/artifacts"]="GET"
  ["/api/argus/mode/runs/1/tasks/1/approve"]="POST"
  ["/api/argus/mode/gate"]="GET"
  ["/health"]="GET"
  ["/api-docs"]="GET"
  ["/api/auth/status"]="GET"
  ["/api/auth/login"]="POST"
  ["/api/auth/token"]="GET"
  ["/api/auth/logout"]="POST"
  ["/api/agent/chat"]="POST"
  ["/api/projects"]="GET"
  ["/api/templates/clone"]="POST"
  ["/api/argus/health"]="GET"
  ["/api/argus/status?projectPath=test"]="GET"
  ["/api/argus/pause"]="POST"
  ["/api/argus/resume"]="POST"
  ["/api/argus/wake"]="POST"
  ["/api/argus/reconcile"]="POST"
  ["/api/features"]="POST"
  ["/api/settings"]="GET"
)

echo "Testing Endpoints with Authentication..." > results.log

for path in "${!ENDPOINTS[@]}"; do
  method=${ENDPOINTS[$path]}
  echo -n "Testing $method $path ... "
  echo "--- $method $path ---" >> results.log

  # According to the API docs: {"bearer":true,"xApiKey":true,"sessionCookie":true,"queryParamApiKey":true,"envVarForApiKey":"AUTHENTICATION_TOKEN"}
  # I'll pass the token as both Bearer and X-API-Key to maximize chance of success.

  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X GET "$BASE_URL$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "X-API-Key: $TOKEN")
  elif [ "$method" = "POST" ]; then
    if [ "$path" = "/api/auth/login" ]; then
        response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL$path" \
          -H "Content-Type: application/json" -d "{\"apiKey\": \"$TOKEN\"}")
    else
        response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BASE_URL$path" \
          -H "Authorization: Bearer $TOKEN" \
          -H "X-API-Key: $TOKEN" \
          -H "Content-Type: application/json" -d '{}')
    fi
  elif [ "$method" = "PUT" ]; then
    response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X PUT "$BASE_URL$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "X-API-Key: $TOKEN" \
      -H "Content-Type: application/json" -d '{}')
  fi

  http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d':' -f2)
  body=$(echo "$response" | sed '/HTTP_CODE:/d')

  echo "Status: $http_code"
  echo "Status: $http_code" >> results.log
  echo "Body: $body" >> results.log
  echo "" >> results.log
done

echo "Done."
