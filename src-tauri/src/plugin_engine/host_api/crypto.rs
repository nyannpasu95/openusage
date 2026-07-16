use super::*;

pub(crate) fn decrypt_aes_256_gcm_envelope(
    envelope: &str,
    key_b64: &str,
) -> Result<String, String> {
    let trimmed_envelope = envelope.trim();
    let trimmed_key = key_b64.trim();
    let parts: Vec<&str> = trimmed_envelope.split(':').collect();
    if parts.len() != 3 {
        return Err("invalid AES-GCM envelope".to_string());
    }

    let key = BASE64_STANDARD
        .decode(trimmed_key)
        .map_err(|e| format!("invalid base64 key: {}", e))?;
    if key.len() != 32 {
        return Err(format!(
            "invalid AES-256 key length: expected 32 bytes, got {}",
            key.len()
        ));
    }

    let iv = BASE64_STANDARD
        .decode(parts[0])
        .map_err(|e| format!("invalid base64 iv: {}", e))?;
    if iv.len() != 16 {
        return Err(format!(
            "invalid AES-GCM iv length: expected 16 bytes, got {}",
            iv.len()
        ));
    }

    let tag = BASE64_STANDARD
        .decode(parts[1])
        .map_err(|e| format!("invalid base64 auth tag: {}", e))?;
    if tag.len() != 16 {
        return Err(format!(
            "invalid AES-GCM auth tag length: expected 16 bytes, got {}",
            tag.len()
        ));
    }

    let ciphertext = BASE64_STANDARD
        .decode(parts[2])
        .map_err(|e| format!("invalid base64 ciphertext: {}", e))?;

    type Aes256Gcm16 = AesGcm<Aes256, U16>;
    let cipher =
        Aes256Gcm16::new_from_slice(&key).map_err(|e| format!("decrypt init failed: {}", e))?;
    let nonce = Nonce::<U16>::from_slice(&iv);

    let mut ciphertext_and_tag = ciphertext;
    ciphertext_and_tag.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag.as_ref())
        .map_err(|_| "decrypt finalize failed".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("decrypted payload is not UTF-8: {}", e))
}

pub(crate) fn encrypt_aes_256_gcm_envelope(
    plaintext: &str,
    key_b64: &str,
) -> Result<String, String> {
    let trimmed_key = key_b64.trim();
    let key = BASE64_STANDARD
        .decode(trimmed_key)
        .map_err(|e| format!("invalid base64 key: {}", e))?;
    if key.len() != 32 {
        return Err(format!(
            "invalid AES-256 key length: expected 32 bytes, got {}",
            key.len()
        ));
    }

    type Aes256Gcm16 = AesGcm<Aes256, U16>;
    let cipher =
        Aes256Gcm16::new_from_slice(&key).map_err(|e| format!("encrypt init failed: {}", e))?;
    let mut iv = [0_u8; 16];
    OsRng.fill_bytes(&mut iv);
    let nonce = Nonce::<U16>::from_slice(&iv);
    let ciphertext_and_tag = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| "encrypt finalize failed".to_string())?;
    if ciphertext_and_tag.len() < 16 {
        return Err("encrypted payload missing auth tag".to_string());
    }
    let split_at = ciphertext_and_tag.len() - 16;
    let (ciphertext, tag) = ciphertext_and_tag.split_at(split_at);

    Ok(format!(
        "{}:{}:{}",
        BASE64_STANDARD.encode(iv),
        BASE64_STANDARD.encode(tag),
        BASE64_STANDARD.encode(ciphertext)
    ))
}

pub(crate) fn inject_crypto<'js>(ctx: &Ctx<'js>, host: &Object<'js>) -> rquickjs::Result<()> {
    let crypto_obj = Object::new(ctx.clone())?;

    crypto_obj.set(
        "decryptAes256Gcm",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  envelope: String,
                  key_b64: String|
                  -> rquickjs::Result<String> {
                decrypt_aes_256_gcm_envelope(&envelope, &key_b64)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e))
            },
        )?,
    )?;

    crypto_obj.set(
        "encryptAes256Gcm",
        Function::new(
            ctx.clone(),
            move |ctx_inner: Ctx<'_>,
                  plaintext: String,
                  key_b64: String|
                  -> rquickjs::Result<String> {
                encrypt_aes_256_gcm_envelope(&plaintext, &key_b64)
                    .map_err(|e| Exception::throw_message(&ctx_inner, &e))
            },
        )?,
    )?;

    crypto_obj.set(
        "sha256Hex",
        Function::new(ctx.clone(), move |text: String| -> String {
            let digest = Sha256::digest(text.as_bytes());
            // Lowercase hex, matches Node's `crypto.createHash("sha256").update(x).digest("hex")`
            // and the upstream Claude Code keychain helper.
            let mut out = String::with_capacity(digest.len() * 2);
            for byte in digest.iter() {
                use std::fmt::Write as _;
                let _ = write!(&mut out, "{:02x}", byte);
            }
            out
        })?,
    )?;

    host.set("crypto", crypto_obj)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    fn encrypt_aes_256_gcm_envelope_for_test(key: &[u8], plaintext: &str) -> String {
        let iv = [7_u8; 16];
        type Aes256Gcm16 = AesGcm<Aes256, U16>;
        let cipher = Aes256Gcm16::new_from_slice(key).expect("encrypt init");
        let nonce = Nonce::<U16>::from_slice(&iv);
        let ciphertext_and_tag = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .expect("encrypt finalize");
        let split_at = ciphertext_and_tag.len() - 16;
        let (ciphertext, tag) = ciphertext_and_tag.split_at(split_at);

        format!(
            "{}:{}:{}",
            BASE64_STANDARD.encode(iv),
            BASE64_STANDARD.encode(tag),
            BASE64_STANDARD.encode(ciphertext)
        )
    }

    fn node_generated_aes_256_gcm_vector_for_test() -> (&'static str, &'static str, &'static str) {
        (
            "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=",
            "BwcHBwcHBwcHBwcHBwcHBw==:yFbCs4LOJ0aj9NPNf5pfVA==:7PKjtOdATLClvaWrMw0b0M8Nov4KPhxwQX4hdczqQlcZi9Zhi6DjAoK+WolvMwuhPIk=",
            r#"{"access_token":"token","refresh_token":"refresh"}"#,
        )
    }

    #[test]
    fn decrypt_aes_256_gcm_envelope_round_trips_plaintext() {
        let key = [11_u8; 32];
        let key_b64 = BASE64_STANDARD.encode(key);
        let plaintext = r#"{"access_token":"token","refresh_token":"refresh"}"#;
        let envelope = encrypt_aes_256_gcm_envelope_for_test(&key, plaintext);

        let decrypted =
            decrypt_aes_256_gcm_envelope(&envelope, &key_b64).expect("decrypt envelope");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_aes_256_gcm_envelope_round_trips_plaintext() {
        let key = [21_u8; 32];
        let key_b64 = BASE64_STANDARD.encode(key);
        let plaintext = r#"{"access_token":"token-2","refresh_token":"refresh-2"}"#;

        let envelope = encrypt_aes_256_gcm_envelope(plaintext, &key_b64).expect("encrypt envelope");
        let decrypted =
            decrypt_aes_256_gcm_envelope(&envelope, &key_b64).expect("decrypt envelope");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_aes_256_gcm_envelope_rejects_invalid_component_lengths() {
        let key_b64 = BASE64_STANDARD.encode([9_u8; 32]);
        let short_key_b64 = BASE64_STANDARD.encode([7_u8; 31]);
        let iv_b64 = BASE64_STANDARD.encode([1_u8; 15]);
        let tag_b64 = BASE64_STANDARD.encode([2_u8; 16]);
        let ciphertext_b64 = BASE64_STANDARD.encode([3_u8; 8]);

        let key_err =
            decrypt_aes_256_gcm_envelope("AQ==:AQ==:AQ==", &short_key_b64).expect_err("key length");
        assert!(key_err.contains("expected 32 bytes"));

        let iv_err = decrypt_aes_256_gcm_envelope(
            &format!("{}:{}:{}", iv_b64, tag_b64, ciphertext_b64),
            &key_b64,
        )
        .expect_err("iv length");
        assert!(iv_err.contains("iv length"));

        let short_tag_b64 = BASE64_STANDARD.encode([2_u8; 15]);
        let tag_err = decrypt_aes_256_gcm_envelope(
            &format!(
                "{}:{}:{}",
                BASE64_STANDARD.encode([1_u8; 16]),
                short_tag_b64,
                ciphertext_b64
            ),
            &key_b64,
        )
        .expect_err("tag length");
        assert!(tag_err.contains("auth tag length"));
    }

    #[test]
    fn crypto_api_exposes_decrypt() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let globals = ctx.globals();
            let probe_ctx: Object = globals.get("__openusage_ctx").expect("probe ctx");
            let host: Object = probe_ctx.get("host").expect("host");
            let crypto: Object = host.get("crypto").expect("crypto");
            let _decrypt: Function = crypto.get("decryptAes256Gcm").expect("decryptAes256Gcm");
            let _encrypt: Function = crypto.get("encryptAes256Gcm").expect("encryptAes256Gcm");
        });
    }

    #[test]
    fn crypto_api_decrypts_node_generated_envelope_from_js() {
        let (key_b64, envelope, expected_plaintext) = node_generated_aes_256_gcm_vector_for_test();
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            let js_expr = format!(
                r#"__openusage_ctx.host.crypto.decryptAes256Gcm("{}", "{}")"#,
                envelope, key_b64
            );
            let decrypted: String = ctx.eval(js_expr).expect("js decrypt");
            assert_eq!(decrypted, expected_plaintext);
        });
    }

    #[test]
    fn crypto_api_exposes_sha256_hex() {
        let rt = Runtime::new().expect("runtime");
        let ctx = Context::full(&rt).expect("context");
        ctx.with(|ctx| {
            let app_data = std::env::temp_dir();
            inject_host_api(&ctx, "test", &app_data, "0.0.0").expect("inject host api");
            // Vector: `printf '%s' 'hello' | shasum -a 256`
            let result: String = ctx
                .eval(r#"__openusage_ctx.host.crypto.sha256Hex("hello")"#)
                .expect("js sha256");
            assert_eq!(
                result,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            );

            let empty: String = ctx
                .eval(r#"__openusage_ctx.host.crypto.sha256Hex("")"#)
                .expect("js sha256 empty");
            assert_eq!(
                empty,
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
        });
    }
}
