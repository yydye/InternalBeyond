# The app is not minified in M1-C. Keep this file present so the release block
# stays valid, and so a future minify stage has an obvious place to add rules.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
