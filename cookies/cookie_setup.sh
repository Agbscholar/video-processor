#!/bin/bash
# Cookie extraction and setup script for YouTube processor

# Create cookies directory
mkdir -p /app/cookies

# Method 1: Extract cookies from Chrome (if available)
extract_chrome_cookies() {
    echo "Attempting to extract Chrome cookies..."
    
    # Try different Chrome cookie locations
    CHROME_PATHS=(
        "$HOME/.config/google-chrome/Default/Cookies"
        "$HOME/Library/Application Support/Google/Chrome/Default/Cookies"
        "/opt/google/chrome/Cookies"
    )
    
    for path in "${CHROME_PATHS[@]}"; do
        if [ -f "$path" ]; then
            echo "Found Chrome cookies at: $path"
            # Use yt-dlp to extract cookies
            yt-dlp --cookies-from-browser chrome --print-cookies > /app/cookies/youtube_cookies.txt
            if [ $? -eq 0 ]; then
                echo "Successfully extracted Chrome cookies"
                return 0
            fi
        fi
    done
    
    echo "Chrome cookies not found or extraction failed"
    return 1
}

# Method 2: Manual cookie setup instructions
setup_manual_cookies() {
    cat << 'EOF'
To manually set up YouTube cookies:

1. Open YouTube in your browser and log in
2. Open Developer Tools (F12)
3. Go to Network tab
4. Refresh the page
5. Find a request to youtube.com
6. Right-click and select "Copy as cURL"
7. Extract cookies from the cURL command

Or use browser extensions like "Export Cookies" to export in Netscape format.

Save the cookies to: /app/cookies/youtube_cookies.txt

Example cookie format:
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	FALSE	1234567890	session_token	your_session_token_here
.youtube.com	TRUE	/	TRUE	1234567890	LOGIN_INFO	your_login_info_here
EOF
}

# Method 3: Create a basic cookie template
create_cookie_template() {
    cat > /app/cookies/youtube_cookies_template.txt << 'EOF'
# Netscape HTTP Cookie File
# This is a template - replace with your actual YouTube cookies
# 
# Format: domain	domain_specified	path	secure	expiry	name	value
#
# .youtube.com	TRUE	/	FALSE	1735689600	VISITOR_INFO1_LIVE	your_visitor_info
# .youtube.com	TRUE	/	TRUE	1735689600	LOGIN_INFO	your_login_info
# .youtube.com	TRUE	/	FALSE	1735689600	PREF	your_preferences
# .youtube.com	TRUE	/	FALSE	1735689600	SID	your_session_id
# .youtube.com	TRUE	/	FALSE	1735689600	HSID	your_hsid
# .youtube.com	TRUE	/	FALSE	1735689600	SSID	your_ssid
# .youtube.com	TRUE	/	FALSE	1735689600	APISID	your_apisid
# .youtube.com	TRUE	/	FALSE	1735689600	SAPISID	your_sapisid
EOF
}

# Main execution
main() {
    echo "Setting up YouTube cookie authentication..."
    
    # Try to extract from Chrome first
    if extract_chrome_cookies; then
        echo "Cookie setup completed successfully!"
        return 0
    fi
    
    # If Chrome extraction fails, create template and show instructions
    echo "Automatic cookie extraction failed. Setting up manual process..."
    create_cookie_template
    setup_manual_cookies
    
    echo ""
    echo "Cookie template created at: /app/cookies/youtube_cookies_template.txt"
    echo "Please follow the manual instructions above to set up your cookies."
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi