# Dedicated shared-terminal startup: retain the user's existing login setup.
[[ -r /etc/profile ]] && source /etc/profile
for browser_terminal_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -r $browser_terminal_profile ]]; then
        source "$browser_terminal_profile"
        break
    fi
done
unset browser_terminal_profile
source "${BASH_SOURCE[0]%/*}/shell-features.bash"
