// Estrategias de login social (OAuth 2.0) con Passport.
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/user.model');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const enabled = { github: false, google: false };

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/api/auth/github/callback`,
      scope: ['user:email'],
    },
    (_accessToken, _refreshToken, profile, done) => {
      // GitHub puede ocultar el email; en ese caso se usa un email interno.
      const email = (profile.emails?.[0]?.value || `${profile.username}@users.noreply.github.com`).toLowerCase();
      const user = User.findOrCreateOAuth({
        provider: 'github', providerId: profile.id, email, fullName: profile.displayName || profile.username,
      });
      done(null, user);
    }
  ));
  enabled.github = true;
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/api/auth/google/callback`,
    },
    (_accessToken, _refreshToken, profile, done) => {
      const user = User.findOrCreateOAuth({
        provider: 'google', providerId: profile.id, email: profile.emails[0].value.toLowerCase(), fullName: profile.displayName,
      });
      done(null, user);
    }
  ));
  enabled.google = true;
}

module.exports = { passport, enabled };
