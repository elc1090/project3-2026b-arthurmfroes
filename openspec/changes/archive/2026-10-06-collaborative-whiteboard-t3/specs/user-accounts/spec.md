# Spec Delta

## Purpose

Defines how people obtain a persistent identity and an authenticated session for accessing the collaborative whiteboard.

## ADDED Requirements

### Requirement: Username and password registration
The system SHALL allow a person to register with a username and password without requiring an email address or email verification.

#### Scenario: Registration without email
- **WHEN** a person submits an available username and a valid password without an email address
- **THEN** the system creates an account that can be used to sign in

### Requirement: Protected password storage
The system MUST store each password using Argon2id with a unique random salt and MUST NOT store the plaintext password.

#### Scenario: Account creation
- **WHEN** a person creates an account
- **THEN** persistent account storage contains a salted Argon2id password hash and no plaintext password

### Requirement: Authenticated sessions
The system SHALL allow a registered person to sign in with their username and password and establish an authenticated session.

#### Scenario: Valid credentials
- **WHEN** a registered person supplies the correct username and password
- **THEN** the system establishes a session associated with that account

#### Scenario: Invalid credentials
- **WHEN** a person supplies an incorrect password
- **THEN** the system rejects the sign-in attempt

### Requirement: Session cookie protection
The system MUST protect browser session cookies with HttpOnly, Secure, and SameSite attributes when deployed over HTTPS.

#### Scenario: Successful sign-in on the deployed site
- **WHEN** a person signs in over HTTPS
- **THEN** the issued session cookie has HttpOnly, Secure, and SameSite attributes
