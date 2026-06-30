import SwiftUI

/// User picker: tap an avatar, enter PIN if needed, start chatting.
struct UserPickerView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.colorScheme) private var colorScheme
    @State private var users: [ServerUser] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var pinTarget: ServerUser?
    @State private var pinText = ""
    @State private var pinError: String?
    @State private var showAddHousehold = false
    @State private var showAdminLogin = false
    @State private var adminUsername = ""
    @State private var adminPassword = ""
    @State private var adminError: String?
    // Invite-code enrollment + self-service PIN setup.
    @State private var showEnroll = false
    @State private var enrollCode = ""
    @State private var enrollError: String?
    @State private var enrollBusy = false
    /// A redeemed enrollment held until a member sets their PIN (members only).
    @State private var pendingEnroll: (userId: String, token: String, user: DeviceUser)?
    @State private var pinSetupText = ""
    @State private var pinSetupConfirm = ""
    @State private var pinSetupError: String?

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)

        ZStack {
            theme.surface.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                // Header
                VStack(spacing: 8) {
                    BoaterHat(size: 32, color: theme.ink)

                    Text(session.localized("picker.title"))
                        .font(.system(size: 28, design: .serif))
                        .foregroundStyle(theme.ink)
                }

                // Household switcher — pick which household, or add another.
                if !session.households.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(session.households) { h in
                            let on = h.id == session.currentHouseholdId
                            Button { session.switchHousehold(h.id) } label: {
                                HStack(spacing: 7) {
                                    FoyerBadge(household: h, size: 20, radius: 6)
                                    Text(h.name)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(on ? theme.ink : theme.inkSoft)
                                }
                                .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 5)
                                .background(Capsule().fill(on ? theme.ink.opacity(0.08) : .clear))
                                .overlay(Capsule().strokeBorder(on ? theme.ink : theme.ruleHard, lineWidth: 0.5))
                            }
                            .buttonStyle(.plain)
                        }
                        Button { showAddHousehold = true } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(theme.inkSoft)
                                .frame(width: 30, height: 30)
                                .overlay(Circle().strokeBorder(theme.ruleHard, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                }

                // User grid
                if isLoading {
                    ProgressView()
                        .padding(40)
                } else if users.isEmpty {
                    VStack(spacing: 16) {
                        Text(session.localized("picker.empty"))
                            .font(.system(size: 14))
                            .foregroundStyle(theme.inkMute)
                            .multilineTextAlignment(.center)

                        Button(session.localized("enroll.cta")) {
                            showEnroll = true
                        }
                        .buttonStyle(.borderedProminent)

                        Button(session.localized("picker.admin_signin")) {
                            showAdminLogin = true
                        }
                        .buttonStyle(.bordered)
                    }
                } else {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 90, maximum: 120), spacing: 24)],
                        spacing: 24
                    ) {
                        ForEach(users) { user in
                            UserAvatarButton(user: user, serverURL: session.serverURL) {
                                handleUserTap(user)
                            }
                        }
                    }
                    .padding(.horizontal, 48)
                }

                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Spacer()
                Spacer()

                // Invite-code entry (also reachable when the device already has
                // users — for adding another household member) + disconnect.
                VStack(spacing: 14) {
                    if !users.isEmpty {
                        Button(session.localized("enroll.cta")) { showEnroll = true }
                            .font(.system(size: 13))
                            .buttonStyle(.plain)
                            .foregroundStyle(theme.inkSoft)
                    }
                    Button {
                        session.unpair()
                    } label: {
                        Text(session.localized("picker.disconnect"))
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(theme.inkMute)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, 24)
            }

            // PIN overlay
            if let target = pinTarget {
                PinOverlay(
                    user: target,
                    pinText: $pinText,
                    pinError: $pinError,
                    onSubmit: { submitPin(for: target) },
                    onCancel: { pinTarget = nil; pinText = ""; pinError = nil }
                )
            }

            // Admin login overlay
            if showAdminLogin {
                AdminLoginOverlay(
                    username: $adminUsername,
                    password: $adminPassword,
                    error: $adminError,
                    onSubmit: { Task { await adminLogin() } },
                    onCancel: {
                        showAdminLogin = false
                        adminUsername = ""
                        adminPassword = ""
                        adminError = nil
                    }
                )
            }

            // Invite-code enrollment
            if showEnroll {
                InviteEnrollOverlay(
                    code: $enrollCode,
                    error: $enrollError,
                    busy: enrollBusy,
                    onSubmit: { Task { await enrollWithCode() } },
                    onCancel: { showEnroll = false; enrollCode = ""; enrollError = nil }
                )
            }

            // Self-service PIN setup (members only, after enrolling — required)
            if pendingEnroll != nil {
                PinSetupOverlay(
                    pin: $pinSetupText,
                    confirm: $pinSetupConfirm,
                    error: $pinSetupError,
                    onSubmit: { Task { await submitPinSetup() } }
                )
            }
        }
        .task(id: session.currentHouseholdId) {
            await fetchUsers()
        }
        .sheet(isPresented: $showAddHousehold) {
            PairingView(onPaired: { showAddHousehold = false })
                .environment(session)
        }
    }

    private func enrollWithCode() async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)
        enrollError = nil
        enrollBusy = true
        defer { enrollBusy = false }
        do {
            var body: [String: String] = ["code": enrollCode.trimmingCharacters(in: .whitespacesAndNewlines)]
            if let deviceId = session.deviceId { body["device_id"] = deviceId }
            let resp: EnrollResponse = try await api.post("/api/auth/enroll", body: body)
            let me: ServerUser = try await api.get("/api/users/me", token: resp.token)
            showEnroll = false
            enrollCode = ""
            if resp.needs_pin {
                // Hold the session until the member sets their PIN.
                pendingEnroll = (resp.user_id, resp.token, DeviceUser(from: me))
            } else {
                // Guest: sign in now; the device stays locked to this account.
                finishEnroll(userId: resp.user_id, token: resp.token, user: DeviceUser(from: me))
            }
        } catch let err as APIError {
            if case .server(_, let msg) = err { enrollError = msg } else { enrollError = err.localizedDescription }
        } catch {
            enrollError = error.localizedDescription
        }
    }

    private func submitPinSetup() async {
        guard let pending = pendingEnroll, let url = session.serverURL else { return }
        let pin = pinSetupText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pin.count >= 4, pin.count <= 6, pin.allSatisfy(\.isNumber) else {
            pinSetupError = session.localized("pinsetup.invalid"); return
        }
        guard pin == pinSetupConfirm.trimmingCharacters(in: .whitespacesAndNewlines) else {
            pinSetupError = session.localized("pinsetup.mismatch"); return
        }
        let api = APIClient(baseURL: url)
        do {
            let _: OkResponse = try await api.post("/api/auth/set-pin", body: ["pin": pin], token: pending.token)
            let u = pending.user
            finishEnroll(userId: pending.userId, token: pending.token,
                         user: DeviceUser(id: u.id, displayName: u.displayName, avatarColor: u.avatarColor, hasPin: true, role: u.role))
            pendingEnroll = nil
            pinSetupText = ""; pinSetupConfirm = ""; pinSetupError = nil
        } catch let err as APIError {
            if case .server(_, let msg) = err { pinSetupError = msg } else { pinSetupError = err.localizedDescription }
        } catch {
            pinSetupError = error.localizedDescription
        }
    }

    private func finishEnroll(userId: String, token: String, user: DeviceUser) {
        session.loginUser(userId, token: token)
        var updated = session.deviceUsers.filter { $0.id != userId }
        updated.append(user)
        session.updateDeviceUsers(updated)
    }

    private func fetchUsers() async {
        guard let url = session.serverURL else { return }
        isLoading = true
        error = nil

        do {
            let api = APIClient(baseURL: url)

            if let token = session.deviceUsers.compactMap({ session.tokenForUser($0.id) }).first {
                users = try await api.get("/api/users", token: token)
            } else {
                users = []
            }
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    private func adminLogin() async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)
        adminError = nil

        do {
            let response: LoginResponse = try await api.post(
                "/api/auth/login",
                body: ["username": adminUsername, "password": adminPassword]
            )

            session.loginUser(response.user_id, token: response.token)
            users = try await api.get("/api/users", token: response.token)
            session.updateDeviceUsers(users.map { DeviceUser(from: $0) })

            showAdminLogin = false
            adminUsername = ""
            adminPassword = ""
        } catch let err as APIError {
            switch err {
            case .server(_, let msg): adminError = msg
            default: adminError = err.localizedDescription
            }
        } catch {
            adminError = error.localizedDescription
        }
    }

    private func handleUserTap(_ user: ServerUser) {
        // Users with a PIN must always verify, even if a token is cached
        if user.has_pin {
            pinTarget = user
            pinText = ""
            pinError = nil
            return
        }

        // No PIN — try fast switch with cached token, else login without PIN
        if session.switchToUser(user.id) {
            return
        }
        Task { await loginUser(user, pin: nil) }
    }

    private func submitPin(for user: ServerUser) {
        Task { await loginUser(user, pin: pinText) }
    }

    private func loginUser(_ user: ServerUser, pin: String?) async {
        guard let url = session.serverURL else { return }
        let api = APIClient(baseURL: url)

        do {
            var body: [String: String] = ["user_id": user.id]
            if let pin { body["pin"] = pin }
            if let deviceId = session.deviceId { body["device_id"] = deviceId }

            let response: LoginResponse = try await api.post(
                "/api/auth/login",
                body: body
            )

            session.loginUser(user.id, token: response.token)

            let deviceUser = DeviceUser(from: user)
            var updated = session.deviceUsers.filter { $0.id != user.id }
            updated.append(deviceUser)
            session.updateDeviceUsers(updated)

            if users.isEmpty {
                users = try await api.get("/api/users", token: response.token)
                session.updateDeviceUsers(users.map { DeviceUser(from: $0) })
            }

            pinTarget = nil
            pinText = ""
            pinError = nil
        } catch {
            if pinTarget != nil {
                pinError = session.localized("picker.pin.error")
                pinText = ""
            } else {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - User Avatar Button

private struct UserAvatarButton: View {
    @Environment(\.colorScheme) private var colorScheme
    let user: ServerUser
    var serverURL: String? = nil
    let action: () -> Void

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)

        Button(action: action) {
            VStack(spacing: 10) {
                UserAvatar(avatarURL: user.avatar_url, serverURL: serverURL,
                           initial: String(user.display_name.prefix(1)),
                           color: Color(hex: user.avatar_color), size: 64)

                VStack(spacing: 2) {
                    Text(user.display_name)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.ink)

                    if user.has_pin {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(theme.inkMute)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - PIN Overlay

private struct PinOverlay: View {
    @Environment(\.colorScheme) private var colorScheme
    let user: ServerUser
    @Binding var pinText: String
    @Binding var pinError: String?
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)

        ZStack {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { onCancel() }

            VStack(spacing: 20) {
                Text(user.display_name)
                    .font(.system(size: 22, design: .serif))
                    .foregroundStyle(theme.ink)

                Text(L("picker.pin.title"))
                    .font(.system(size: 14))
                    .foregroundStyle(theme.inkSoft)

                SecureField(L("picker.pin.placeholder"), text: $pinText)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .frame(width: 160)
                    .multilineTextAlignment(.center)
                    .onSubmit { onSubmit() }

                if let pinError {
                    Text(pinError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack(spacing: 16) {
                    Button(L("picker.pin.cancel")) { onCancel() }
                        .buttonStyle(.bordered)
                    Button(L("picker.pin.submit")) { onSubmit() }
                        .buttonStyle(.borderedProminent)
                        .disabled(pinText.isEmpty)
                }
            }
            .padding(32)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(theme.surface)
                    .shadow(radius: 20)
            )
        }
    }
}

// MARK: - Admin Login Overlay

private struct AdminLoginOverlay: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var username: String
    @Binding var password: String
    @Binding var error: String?
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)

        ZStack {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { onCancel() }

            VStack(spacing: 20) {
                Text(L("picker.admin.title"))
                    .font(.system(size: 22, design: .serif))
                    .foregroundStyle(theme.ink)

                Text(L("picker.admin.subtitle"))
                    .font(.system(size: 14))
                    .foregroundStyle(theme.inkSoft)

                VStack(spacing: 12) {
                    TextField(L("picker.admin.username"), text: $username)
                        .textFieldStyle(.roundedBorder)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #endif
                        .frame(width: 220)

                    SecureField(L("picker.admin.password"), text: $password)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 220)
                        .onSubmit { onSubmit() }
                }

                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack(spacing: 16) {
                    Button(L("picker.admin.cancel")) { onCancel() }
                        .buttonStyle(.bordered)
                    Button(L("picker.admin.submit")) { onSubmit() }
                        .buttonStyle(.borderedProminent)
                        .disabled(username.isEmpty || password.isEmpty)
                }
            }
            .padding(32)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(theme.surface)
                    .shadow(radius: 20)
            )
        }
    }
}

// MARK: - Invite Enroll Overlay

private struct InviteEnrollOverlay: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var code: String
    @Binding var error: String?
    let busy: Bool
    let onSubmit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea().onTapGesture { onCancel() }
            VStack(spacing: 20) {
                Text(L("enroll.title"))
                    .font(.system(size: 22, design: .serif)).foregroundStyle(theme.ink)
                Text(L("enroll.subtitle"))
                    .font(.system(size: 14)).foregroundStyle(theme.inkSoft)
                    .multilineTextAlignment(.center)

                TextField(L("enroll.placeholder"), text: $code)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    #endif
                    .frame(width: 220)
                    .multilineTextAlignment(.center)
                    .onSubmit { onSubmit() }

                if let error {
                    Text(error).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center)
                }

                HStack(spacing: 16) {
                    Button(L("picker.admin.cancel")) { onCancel() }.buttonStyle(.bordered)
                    Button(L("enroll.submit")) { onSubmit() }
                        .buttonStyle(.borderedProminent)
                        .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
            .padding(32)
            .background(RoundedRectangle(cornerRadius: 16).fill(theme.surface).shadow(radius: 20))
        }
    }
}

// MARK: - PIN Setup Overlay (required for members after enrolling)

private struct PinSetupOverlay: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var pin: String
    @Binding var confirm: String
    @Binding var error: String?
    let onSubmit: () -> Void

    var body: some View {
        let theme = MauriceTheme.current(for: colorScheme)
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(spacing: 18) {
                Text(L("pinsetup.title"))
                    .font(.system(size: 22, design: .serif)).foregroundStyle(theme.ink)
                Text(L("pinsetup.subtitle"))
                    .font(.system(size: 14)).foregroundStyle(theme.inkSoft)
                    .multilineTextAlignment(.center)

                SecureField(L("pinsetup.placeholder"), text: $pin)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .frame(width: 160).multilineTextAlignment(.center)
                SecureField(L("pinsetup.confirm"), text: $confirm)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .keyboardType(.numberPad)
                    #endif
                    .frame(width: 160).multilineTextAlignment(.center)
                    .onSubmit { onSubmit() }

                if let error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }

                Button(L("pinsetup.submit")) { onSubmit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(pin.isEmpty || confirm.isEmpty)
            }
            .padding(32)
            .background(RoundedRectangle(cornerRadius: 16).fill(theme.surface).shadow(radius: 20))
        }
    }
}
