#!/usr/bin/env python3
"""
SecureFPS RBAC Test Suite
Tests role-based access control and authorization
"""

import requests
import json
from typing import Dict, Optional

BASE_URL = "http://127.0.0.1:5000/api"
SESSION_PLAYER = requests.Session()
SESSION_ADMIN = requests.Session()

# Test Results
results = {
    "passed": [],
    "failed": [],
}

def test_result(name: str, passed: bool, details: str = ""):
    """Record test result"""
    if passed:
        results["passed"].append(f"✓ {name}")
        print(f"✓ {name}")
    else:
        results["failed"].append(f"✗ {name}: {details}")
        print(f"✗ {name}: {details}")

def create_player(email: str, password: str = "Test@12345") -> Optional[Dict]:
    """Create a player account and return account info"""
    try:
        res = requests.post(f"{BASE_URL}/auth/signup", json={
            "name": email.split("@")[0],
            "email": email,
            "password": password,
        })
        if res.ok:
            data = res.json()
            # Extract MFA secret from signup response
            mfa_secret = data.get("mfa_setup", {}).get("manual_key")
            return {
                "email": email,
                "password": password,
                "mfa_secret": mfa_secret
            }
        return None
    except Exception as e:
        print(f"Error creating player: {e}")
        return None

def login_player(session: requests.Session, email: str, password: str = "Test@12345", mfa_secret: Optional[str] = None) -> bool:
    """Login player and return True if successful"""
    try:
        # Step 1: Password verification
        res = session.post(f"{BASE_URL}/auth/login", json={
            "email": email,
            "password": password,
        })
        if not res.ok:
            print(f"  Login password verification failed: {res.status_code}")
            return False
        
        # Step 2: MFA verification
        import pyotp
        if not mfa_secret:
            mfa_secret = "JBSWY3DPEHPK3PXP"  # Default admin secret
        
        totp = pyotp.TOTP(mfa_secret)
        res = session.post(f"{BASE_URL}/auth/verify-mfa", json={
            "code": totp.now(),
        })
        if not res.ok:
            print(f"  MFA verification failed: {res.status_code}")
            return False
        return True
    except Exception as e:
        print(f"Error logging in: {e}")
        return False

def test_auth():
    """Test 1: Authentication"""
    print("\n=== TEST 1: Authentication ===")
    
    # Login admin
    success = login_player(SESSION_ADMIN, "admin1@gmail.com", "Admin@12345")
    test_result("Admin login", success)
    
    # Create and login player
    player_email = "testplayer@example.com"
    success = login_player(SESSION_PLAYER, player_email)
    if not success:
        print("Warning: Player login failed, skipping player tests")
        return
    
    test_result("Player login", success)

def test_player_endpoints():
    """Test 2: Player endpoints - should work for players and admins"""
    print("\n=== TEST 2: Player Endpoints ===")
    
    # Player profile
    res = SESSION_PLAYER.get(f"{BASE_URL}/player/profile")
    test_result("Player can access /player/profile", res.status_code == 200)
    
    # Player matches
    res = SESSION_PLAYER.get(f"{BASE_URL}/player/matches")
    test_result("Player can access /player/matches", res.status_code == 200)
    
    # Player detections
    res = SESSION_PLAYER.get(f"{BASE_URL}/player/detections")
    test_result("Player can access /player/detections", res.status_code == 200)
    
    # Player account status
    res = SESSION_PLAYER.get(f"{BASE_URL}/player/account-status")
    test_result("Player can access /player/account-status", res.status_code == 200)
    
    # Player security events
    res = SESSION_PLAYER.get(f"{BASE_URL}/player/security-events")
    test_result("Player can access /player/security-events", res.status_code == 200)

def test_admin_endpoints():
    """Test 3: Admin endpoints - only admins can access"""
    print("\n=== TEST 3: Admin Endpoints ===")
    
    # Admin overview
    res = SESSION_ADMIN.get(f"{BASE_URL}/admin/overview")
    test_result("Admin can access /admin/overview", res.status_code == 200,
                f"Status: {res.status_code}" if res.status_code != 200 else "")
    
    # Admin players list
    res = SESSION_ADMIN.get(f"{BASE_URL}/admin/players")
    test_result("Admin can access /admin/players", res.status_code == 200)
    
    # Admin security events
    res = SESSION_ADMIN.get(f"{BASE_URL}/admin/security-events")
    test_result("Admin can access /admin/security-events", res.status_code == 200)

def test_access_control():
    """Test 4: Access Control - players should NOT access admin endpoints"""
    print("\n=== TEST 4: Access Control ===")
    
    # Player tries to access admin overview
    res = SESSION_PLAYER.get(f"{BASE_URL}/admin/overview")
    test_result("Player CANNOT access /admin/overview", res.status_code in [401, 403],
                f"Expected 401/403, got {res.status_code}")
    
    # Player tries to access admin players
    res = SESSION_PLAYER.get(f"{BASE_URL}/admin/players")
    test_result("Player CANNOT access /admin/players", res.status_code in [401, 403],
                f"Expected 401/403, got {res.status_code}")
    
    # Player tries to access admin security events
    res = SESSION_PLAYER.get(f"{BASE_URL}/admin/security-events")
    test_result("Player CANNOT access /admin/security-events", res.status_code in [401, 403],
                f"Expected 401/403, got {res.status_code}")

def test_unauthenticated():
    """Test 5: Unauthenticated access"""
    print("\n=== TEST 5: Unauthenticated Access ===")
    
    session = requests.Session()
    
    # Try player endpoints
    res = session.get(f"{BASE_URL}/player/profile")
    test_result("Unauthenticated CANNOT access /player/profile", res.status_code == 401,
                f"Status: {res.status_code}")
    
    # Try admin endpoints
    res = session.get(f"{BASE_URL}/admin/overview")
    test_result("Unauthenticated CANNOT access /admin/overview", res.status_code in [401, 403],
                f"Status: {res.status_code}")

def test_auth_me():
    """Test 6: /auth/me endpoint returns role"""
    print("\n=== TEST 6: Auth ME Endpoint ===")
    
    # Player /auth/me
    res = SESSION_PLAYER.get(f"{BASE_URL}/auth/me")
    if res.ok:
        data = res.json()
        has_role = "role" in data.get("user", {})
        test_result("Player /auth/me includes role", has_role)
        if has_role:
            test_result("Player role is 'player'", data["user"]["role"] == "player")
    else:
        test_result("Player /auth/me works", False, f"Status: {res.status_code}")
    
    # Admin /auth/me
    res = SESSION_ADMIN.get(f"{BASE_URL}/auth/me")
    if res.ok:
        data = res.json()
        has_role = "role" in data.get("user", {})
        test_result("Admin /auth/me includes role", has_role)
        if has_role:
            test_result("Admin role is 'admin'", data["user"]["role"] == "admin")
    else:
        test_result("Admin /auth/me works", False, f"Status: {res.status_code}")

def print_summary():
    """Print test summary"""
    print("\n" + "="*60)
    print(f"PASSED: {len(results['passed'])}")
    for test in results['passed']:
        print(f"  {test}")
    
    if results['failed']:
        print(f"\nFAILED: {len(results['failed'])}")
        for test in results['failed']:
            print(f"  {test}")
    else:
        print("\n✓ ALL TESTS PASSED")
    
    print("="*60)

if __name__ == "__main__":
    print("SecureFPS RBAC Test Suite")
    print("="*60)
    
    test_auth()
    test_player_endpoints()
    test_admin_endpoints()
    test_access_control()
    test_unauthenticated()
    test_auth_me()
    
    print_summary()
