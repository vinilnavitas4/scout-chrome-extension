**Scout**

LinkedIn Profile-to-JD Matching & Scoring Extension

_Developer Workflow & Requirements Document_

# 1\. Overview

Scout is a browser extension that lets a recruiter open a candidate's LinkedIn profile, automatically extract the full profile content, compare it against a target Job Description (JD) stored in JazzHR, and generate a weighted match score out of 100%. Once the recruiter reviews the score, they click "Add to Scout" to push the candidate and score directly into the Scout pipeline inside JazzHR, where the standard JazzHR workflow takes over (pipeline stage, status changes, automated communications, recruiter tasks, etc.).

This document defines the functional requirements, scoring methodology, and end-to-end process flow needed for the development team to scope and build the extension.

## 1.1 Goals

- Eliminate manual resume-vs-JD comparison for first-pass candidate review.
- Standardize scoring across all recruiters using one consistent weighted rubric.
- Reduce time-to-short list by auto-populating JazzHR with scored candidates.
- Keep a human-in-the-loop: scoring informs the recruiter, who still clicks to commit a candidate into the pipeline.

# 2\. High-Level Process Flow

The end-to-end flow has five stages: Capture, Extract, Match, Score, and Commit.

- Capture - Recruiter opens a candidate's LinkedIn profile and clicks the Scout extension icon.
- Extract - Scout parses the full profile (Bio/About, Headline, Experience, Skills, Certifications, Education, Location) into structured data.
- Select JD - Recruiter selects (or Scout auto-detects) the target JazzHR job opening to match against.
- Match & Score - Scout's scoring engine compares structured profile data to the JD's parsed requirements and produces a composite score plus a category breakdown.
- Review - Recruiter views the score card inline (overlay/side panel) on the LinkedIn page.
- Commit - Recruiter clicks "Add to Scout," which creates/updates the candidate record in JazzHR under the matched opening, attaches the score and category breakdown to the candidate record, and hands off to the existing JazzHR workflow.

# 3\. Functional Requirements

## 3.1 LinkedIn Profile Extraction

Scouts must read and structure the entire visible candidate profile, including:

- Basic Info: full name, current title, current company, location/locality
- Headline and About/Bio section (full text, not truncated)
- Experience: every role listed - title, company, dates, and full responsibility/description text per role
- Skills: all listed skills, including endorsement count if available
- Certifications & Licenses: name, issuing body, issue/expiry date if shown
- Education: institution, degree, field of study, dates
- Clearance-related keywords appearing anywhere in headline, About, or experience text (e.g., "Public Trust," "Secret," "Top Secret," "TS/SCI")

## 3.2 JD Source & Parsing (JazzHR Integration)

- Scout pulls the list of open JazzHR job openings via the JazzHR API and lets the recruiter pick the matching requisition, or pre-selects it if Scout was launched from within a JazzHR opening.
- JD text is parsed into the same categories used for scoring: Required Skills, Preferred Skills, Clearance Requirement, Education Requirement, Location/Commute Requirement.

## 3.3 Scoring Engine

Scout calculates a single composite score (0-100%) built from five weighted categories:

| **Category**       | **Weight** | **How It's Scored**                                                                                                                                                                                            |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required Skills    | 35%        | Percentage of JD-required skills found, explicitly or semantically, in the profile's Skills, Experience, and About sections.                                                                                   |
| Preferred Skills   | 15%        | Percentage of JD-preferred (nice-to-have) skills found in the same profile sections.                                                                                                                           |
| Clearance          | 20%        | Match between JD-required clearance level (None / Public Trust / Secret / Top Secret) and clearance detected in profile text. Equal or higher level = full credit; lower or undetected = partial or no credit. |
| Education          | 15%        | Match between JD-required degree level/field and the candidate's Education section.                                                                                                                            |
| Location / Commute | 15%        | Match between candidate location and JD's required locality, including remote/hybrid/onsite eligibility and commute radius if specified.                                                                       |

Independent of the composite score, Scout flags whether each of the four critical categories - Required Skills, Required Certifications, Clearance, and Commute/Locality - is fully matched (pass/fail), since these gate the auto-scheduling rule in Section 4.

## 3.4 score Card UI

- Displayed as an overlay or side panel injected onto the LinkedIn profile page after extraction completes.
- Shows: composite score (large, color-coded), per-category breakdown with weight and sub-score, list of matched vs. missing required skills, detected clearance level, detected location vs. JD requirement.
- Includes the selected JD/opening name and a way to change it before scoring, in case the wrong requisition was auto selected.
- Includes the "Add to Scout" button (primary call to action) and a "Re-score" / "Refresh" option.

# 4\. Auto-Scheduling Rule (Reference)

This mirrors the design already in use on the AI phone screening system, applied here at the resume/profile-matching stage instead of post-call.

| **Condition**           | **Requirement**                                             |
| ----------------------- | ----------------------------------------------------------- |
| Composite Score         | ≥ 80%                                                       |
| Required Skills         | Fully matched                                               |
| Required Certifications | Fully matched                                               |
| Clearance               | Fully matched                                               |
| Commute / Locality      | Fully matched                                               |
| Result if ALL true      | Auto-send self-service scheduling link for next human round |
| Result if ANY false     | Add to pipeline at standard stage; no auto-scheduling       |