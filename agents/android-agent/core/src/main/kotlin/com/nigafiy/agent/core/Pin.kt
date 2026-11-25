package com.nigafiy.agent.core

import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertPathValidator
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * TLS pinning exactly like the Windows agent (`VerifyPinnedChain` in agents/endpoint-agent): the
 * SHA-256 of the leaf certificate, or of a CA certificate in the presented chain that the leaf
 * verifies against (Nigafiy LAN TLS issues the server certificate from its own CA). Without a pin
 * the phone's system trust store decides.
 */
object Pin {
    fun sha256Hex(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** Throws [CertificateException] with the reason when the chain does not match [pinHex]. */
    fun verifyPinnedChain(chain: Array<X509Certificate>, pinHex: String, now: Date = Date()) {
        if (chain.isEmpty()) throw CertificateException("tls pin verification failed: server presented no certificate")
        val want = pinHex.lowercase()
        val leafSum = sha256Hex(chain[0].encoded)
        if (MessageDigest.isEqual(leafSum.toByteArray(), want.toByteArray())) {
            chain[0].checkValidity(now)
            return
        }
        for (i in 1 until chain.size) {
            val ca = chain[i]
            if (ca.basicConstraints < 0) continue
            if (!MessageDigest.isEqual(sha256Hex(ca.encoded).toByteArray(), want.toByteArray())) continue
            try {
                val cf = CertificateFactory.getInstance("X.509")
                // The path from the leaf up to (not including) the pinned CA.
                val path = cf.generateCertPath(chain.slice(0 until i))
                val params = PKIXParameters(setOf(TrustAnchor(ca, null)))
                params.isRevocationEnabled = false
                params.date = now
                CertPathValidator.getInstance("PKIX").validate(path, params)
            } catch (e: Exception) {
                throw CertificateException("tls pin verification failed: server certificate does not verify against the pinned CA: ${e.message}", e)
            }
            return
        }
        throw CertificateException("tls pin mismatch: server leaf certificate sha256 $leafSum does not match configured pin")
    }

    /** A trust manager that accepts only a chain matching [pinHex]. */
    class PinnedTrustManager(private val pinHex: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
            throw CertificateException("client certificates are not used")
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = verifyPinnedChain(chain, pinHex)
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** The socket factory for a server: pinned when a pin is set, the system trust store otherwise. */
    fun socketFactory(pinHex: String?): SSLSocketFactory {
        val ctx = SSLContext.getInstance("TLS")
        if (pinHex == null) {
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(null as KeyStore?)
            ctx.init(null, tmf.trustManagers, null)
        } else {
            ctx.init(null, arrayOf(PinnedTrustManager(pinHex)), null)
        }
        return ctx.socketFactory
    }
}
