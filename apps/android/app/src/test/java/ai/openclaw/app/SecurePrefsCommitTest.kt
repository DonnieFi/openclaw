package ai.openclaw.app

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class SecurePrefsCommitTest {
  @Test
  fun acknowledgedRemovalKeepsGatewayCredentials() {
    val (prefs, _) = fixture()
    prefs.saveGatewayCredentials("gateway-a", token = "gateway-token", bootstrapToken = "bootstrap-token")
    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to "app-token", "access-b" to "other-app-token")))

    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to null)))

    assertNull(prefs.getString("access-a"))
    assertEquals("other-app-token", prefs.getString("access-b"))
    assertEquals(GatewayCredentials(token = "gateway-token", bootstrapToken = "bootstrap-token"), prefs.loadGatewayCredentials("gateway-a"))
  }

  @Test
  fun failedRemovalRestoresMemoryAndReportsFailure() {
    val (prefs, backing) = fixture()
    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to "app-token")))
    backing.failNextCommit = true

    assertFalse(prefs.commitSecureStrings(mapOf("access-a" to null, "access-b" to "new-token")))

    assertEquals("app-token", prefs.getString("access-a"))
    assertNull(prefs.getString("access-b"))
  }

  @Test
  fun proxyChangesPreserveExistingInstallRecordsAcrossPreferenceReopen() {
    val (original, backing) = fixture()
    val app = RuntimeEnvironment.getApplication()
    val endpoint = GatewayEndpoint.manual("gateway.example", 443, true, "/openclaw")
    val other = GatewayEndpoint.manual("other.example", 443, true, "/openclaw")
    val legacyKey = "gateway.credentials.${endpoint.stableId}"
    // Persisted pre-proxy format deliberately has no bootstrapExpiresAtMs field.
    val legacyCredentials = """{"token":"dummy-existing-token","bootstrapToken":"dummy-existing-setup","password":"dummy-existing-password"}"""
    assertTrue(original.commitSecureStrings(mapOf(legacyKey to legacyCredentials)))
    val registry = original.gatewayRegistry
    for ((target, name) in listOf(endpoint to "Home", other to "Work")) {
      registry.upsert(
        GatewayRegistryEntry(
          stableId = target.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = name,
          host = target.host,
          port = target.port,
          tls = true,
          contextPath = target.contextPath,
        ),
      )
    }
    assertTrue(registry.rename(endpoint.stableId, "My existing Gateway"))
    registry.setActive(endpoint.stableId)
    registry.setConnectionEnabled(other.stableId, true)
    val expectedEntries = registry.entries.value
    val expectedConnections = registry.connectedStableIds.value
    val roles = DeviceAuthStore(original)
    for (role in listOf("operator", "node")) {
      assertTrue(
        roles.saveToken(
          endpoint.stableId,
          "dummy-device",
          role,
          "dummy-existing-$role",
          if (role == "operator") listOf("operator.read") else emptyList(),
        ),
      )
    }
    val expectedOperator = roles.loadEntry(endpoint.stableId, "dummy-device", "operator")
    val expectedNode = roles.loadEntry(endpoint.stableId, "dummy-device", "node")
    original.saveGatewayTlsFingerprint(endpoint.stableId, "dummy-existing-fingerprint")
    val legacyHeaders = mapOf("X-Deployment-Route" to "dummy-existing-route")
    original.saveGatewayCustomHeaders(endpoint.stableId, legacyHeaders)
    original.setDisplayName("Existing phone")
    original.setCameraEnabled(false)
    original.setOnboardingCompleted(true)
    assertTrue(original.saveGatewayProxyCredentials(other, GatewayProxyCredentials("dummy-other-user", "dummy-other-password")))

    var prefs = SecurePrefs(app, securePrefsOverride = backing)
    assertNull(prefs.loadGatewayProxyCredentials(endpoint))
    for (password in listOf("dummy-first-password", "dummy-rotated-password", null)) {
      val login = password?.let { GatewayProxyCredentials("dummy-user", it) }
      assertTrue(prefs.saveGatewayProxyCredentials(endpoint, login))
      prefs = SecurePrefs(app, securePrefsOverride = backing)

      assertEquals(password, prefs.loadGatewayProxyCredentials(endpoint)?.password)
      assertEquals("dummy-other-password", prefs.loadGatewayProxyCredentials(other)?.password)
      assertEquals(legacyCredentials, prefs.getString(legacyKey))
      assertEquals(
        GatewayCredentials(token = "dummy-existing-token", bootstrapToken = "dummy-existing-setup", password = "dummy-existing-password"),
        prefs.loadGatewayCredentials(endpoint.stableId),
      )
      assertEquals(expectedOperator, DeviceAuthStore(prefs).loadEntry(endpoint.stableId, "dummy-device", "operator"))
      assertEquals(expectedNode, DeviceAuthStore(prefs).loadEntry(endpoint.stableId, "dummy-device", "node"))
      assertEquals(expectedEntries, prefs.gatewayRegistry.entries.value)
      assertEquals(endpoint.stableId, prefs.gatewayRegistry.activeStableId.value)
      assertEquals(expectedConnections, prefs.gatewayRegistry.connectedStableIds.value)
      assertEquals("dummy-existing-fingerprint", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      assertEquals(legacyHeaders, prefs.loadGatewayCustomHeaders(endpoint.stableId))
      assertEquals("Existing phone", prefs.displayName.value)
      assertFalse(prefs.cameraEnabled.value)
      assertTrue(prefs.onboardingCompleted.value)
    }
  }

  @Test
  fun proxyRotationRetiresOldGrantsOnlyAfterCommitAndPreservesPairingCredentials() =
    runBlocking {
      val (prefs, backing) = fixture()
      val endpoint = GatewayEndpoint.manual("gateway.example", 443, true, "/openclaw")
      val other = GatewayEndpoint.manual("other.example", 443, true, "/openclaw")
      prefs.saveGatewayCredentials(endpoint.stableId, token = "dummy-device-token", bootstrapToken = "dummy-setup")
      assertTrue(prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("dummy-user", "dummy-password")))
      assertTrue(prefs.saveGatewayProxyCredentials(other, GatewayProxyCredentials("other-dummy-user", "other-dummy-password")))
      val oldGrant = requireNotNull(prefs.gatewayProxyAuthorization(endpoint))
      val request = Request.Builder().url("https://gateway.example/openclaw").build()
      val authorized = oldGrant.authorizeUpgrade(request)
      assertTrue(authorized.header("Authorization")!!.startsWith("Basic "))
      backing.failNextCommit = true
      assertFalse(prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("dummy-user", "replacement-dummy")))
      oldGrant.requireCurrent(authorized)
      assertEquals("dummy-password", prefs.loadGatewayProxyCredentials(endpoint)?.password)
      assertTrue(prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("dummy-user", "replacement-dummy")))
      assertThrows(java.io.IOException::class.java) { oldGrant.requireCurrent(authorized) }
      val grant = requireNotNull(prefs.gatewayProxyAuthorization(endpoint))
      for (url in listOf("https://other.example/openclaw", "http://gateway.example/openclaw", "https://gateway.example/another", "https://gateway.example/openclaw-other")) {
        assertThrows(java.io.IOException::class.java) { grant.requireCurrent(Request.Builder().url(url).build()) }
      }
      assertThrows(IllegalArgumentException::class.java) { prefs.loadGatewayProxyCredentials(endpoint.copy(tlsEnabled = false)) }
      assertTrue(prefs.saveGatewayProxyCredentials(endpoint, null))
      assertThrows(java.io.IOException::class.java) { grant.requireCurrent(request) }
      assertNull(prefs.loadGatewayProxyCredentials(endpoint))
      assertEquals("other-dummy-password", prefs.loadGatewayProxyCredentials(other)?.password)
      assertEquals("dummy-device-token", prefs.loadGatewayCredentials(endpoint.stableId).token)
      assertEquals("dummy-setup", prefs.loadGatewayCredentials(endpoint.stableId).bootstrapToken)
      assertEquals("GatewayProxyCredentials([redacted])", GatewayProxyCredentials("dummy-user", "dummy-password").toString())
    }

  private fun fixture(): Pair<SecurePrefs, CommitControlledPreferences> {
    val app = RuntimeEnvironment.getApplication()
    val backing = CommitControlledPreferences(app.getSharedPreferences("access-commit-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    return SecurePrefs(app, securePrefsOverride = backing) to backing
  }

  private class CommitControlledPreferences(
    private val delegate: SharedPreferences,
  ) : SharedPreferences by delegate {
    var failNextCommit = false

    override fun edit(): SharedPreferences.Editor {
      val editor = delegate.edit()
      return object : SharedPreferences.Editor by editor {
        override fun commit(): Boolean {
          if (!failNextCommit) return editor.commit()
          failNextCommit = false
          // SharedPreferences publishes memory before reporting a failed disk commit.
          editor.apply()
          return false
        }
      }
    }
  }
}
