#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dev.agentvis.desktop";

pub(crate) const ANTHROPIC_KEY_ACCOUNT: &str = "anthropic-api-key";
pub(crate) const LOCAL_KEY_ACCOUNT: &str = "local-api-key";
pub(crate) const OPENROUTER_KEY_ACCOUNT: &str = "openrouter-api-key";

pub(crate) trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub(crate) struct SystemSecretStore;

#[cfg(target_os = "macos")]
impl SecretStore for SystemSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        const ITEM_NOT_FOUND: i32 = -25_300;
        match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(secret) => String::from_utf8(secret)
                .map(Some)
                .map_err(|_| "A Keychain API key is not valid UTF-8.".to_owned()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!("Could not read API key from Keychain: {error}")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            account,
            secret.as_bytes(),
        )
        .map_err(|error| format!("Could not save API key to Keychain: {error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        const ITEM_NOT_FOUND: i32 = -25_300;
        match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!("Could not remove API key from Keychain: {error}")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for SystemSecretStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn set(&self, _account: &str, _secret: &str) -> Result<(), String> {
        Err("Secure API key storage currently requires macOS Keychain.".to_owned())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Err("Secure API key storage currently requires macOS Keychain.".to_owned())
    }
}
